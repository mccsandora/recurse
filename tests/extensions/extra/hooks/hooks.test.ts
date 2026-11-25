import { Type } from "typebox";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";

import { createHooks } from "../../../../src/extensions/extra/hooks/index.ts";

test("a PreToolUse hook blocks a bash call with its reason, and SessionStart output reaches the prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recurse-hooks-"));
  const deny = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "review first",
    },
  });
  await writeFile(
    join(dir, "gate.sh"),
    `#!/bin/sh\ninput=$(cat)\nprintf '%s\\n' "$input" >> "${dir}/payloads"\ncase "$input" in *"gh pr create"*) printf '%s' '${deny}';; esac\n`,
    { mode: 0o700 },
  );
  await writeFile(
    join(dir, "hooks.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: `${dir}/gate.sh` }],
          },
          { matcher: "Edit", hooks: [{ type: "command", command: "exit 2" }] },
        ],
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: `printf x >> "${dir}/starts"; echo remember the gate`,
              },
            ],
          },
        ],
      },
    }),
  );
  try {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    const executed: string[] = [];
    const prompts: string[] = [];
    const results: string[] = [];
    registry.install(
      defineExtension({
        name: "fixture",
        tools: [
          defineTool({
            name: "bash",
            description: "capture",
            parameters: Type.Object({ command: Type.String() }),
            execute: async (args) => {
              executed.push(args.command);
              return { output: [{ type: "text", text: "ok" }] };
            },
          }),
        ],
      }),
    );
    const hooks = createHooks(
      dir,
      (id) => `host-${id}`,
      async () => ({ cwd: dir, env: { PATH: process.env.PATH ?? "" } }),
      () => {},
    );
    registry.install(hooks.tool);
    registry.install(hooks.prompt);
    const step =
      (message: ReturnType<typeof fauxAssistantMessage>) => (ctx: any) => {
        prompts.push(JSON.stringify(ctx.messages));
        results.push(JSON.stringify(ctx.messages.at(-1)));
        return message;
      };
    faux.setResponses([
      step(
        fauxAssistantMessage(
          fauxToolCall("bash", { command: "gh pr create" }),
          {
            stopReason: "toolUse",
          },
        ),
      ),
      step(
        fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }), {
          stopReason: "toolUse",
        }),
      ),
      step(fauxAssistantMessage(fauxText("done"))),
    ]);
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry },
      context,
    );
    try {
      const conversation = await harness.root(context, {
        agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: dir },
      });
      await conversation.submit({ type: "input", content: "run" }, context);
      await conversation.waitForIdle(context);
      expect(executed).toEqual(["echo hi"]);
      expect(results[1]).toContain("review first");
      expect(
        prompts.every((p) => p.split("remember the gate").length === 2),
      ).toBe(true);
      expect(await readFile(join(dir, "starts"), "utf8")).toBe("x");
      const payloads = (await readFile(join(dir, "payloads"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        payloads.map((p) => [
          p.hook_event_name,
          p.tool_name,
          p.tool_input.command,
        ]),
      ).toEqual([
        ["PreToolUse", "Bash", "gh pr create"],
        ["PreToolUse", "Bash", "echo hi"],
      ]);
      expect(payloads[0].session_id).toBe(`host-${conversation.id}`);
    } finally {
      await harness.close(context);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

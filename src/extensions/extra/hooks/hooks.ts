// Command hooks from <pi-agent>/hooks.json, in the Claude Code and Codex format,
// so hooks written for those harnesses run here too. Two events: PreToolUse on
// bash, which may block the call, and SessionStart, whose output joins the
// prompt once per conversation. Hook failures fail open; blocks are memoized so
// a resumed call replays its own ruling.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  defineExtension,
  hook,
  section,
  ToolTask,
  type ConversationId,
} from "@earendil-works/pi-durable";

type Scope = { cwd: string; env: Record<string, string> };
type Command = { type?: string; command?: string; timeout?: number };
type Group = { matcher?: string; hooks?: Command[] };
type Ran = { code: number | null; stdout: string; stderr: string };

const HOOKS_FILE_NAME = "hooks.json";
const SECTION = "session_start_hooks";
const DEFAULT_TIMEOUT_S = 60;
// Claude's tool name, so a matcher written for Claude or Codex matches.
const BASH = "Bash";

async function groups(dir: string, event: string): Promise<Group[]> {
  let text: string;
  try {
    text = await readFile(join(dir, HOOKS_FILE_NAME), "utf8");
  } catch {
    return [];
  }
  const found = (JSON.parse(text) as { hooks?: Record<string, Group[]> })
    .hooks?.[event];
  return Array.isArray(found) ? found : [];
}

function commands(found: Group[], tool?: string): Command[] {
  return found
    .filter(
      (g) =>
        tool === undefined ||
        !g.matcher ||
        g.matcher === "*" ||
        new RegExp(`^(?:${g.matcher})$`).test(tool),
    )
    .flatMap((g) => g.hooks ?? [])
    .filter((c) => (c.type ?? "command") === "command" && c.command);
}

function run(command: Command, payload: object, scope: Scope): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command.command!], {
      cwd: scope.cwd,
      env: scope.env,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: (command.timeout ?? DEFAULT_TIMEOUT_S) * 1000,
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) =>
      resolve({ code: null, stdout, stderr: String(error) }),
    );
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

function json(text: string): Record<string, any> | undefined {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The block reason a PreToolUse hook gave: exit 2 with stderr, or a JSON deny. */
function blockReason(ran: Ran): string | undefined {
  if (ran.code === 2) return ran.stderr.trim() || "blocked by a hook";
  if (ran.code !== 0) return undefined;
  const out = json(ran.stdout);
  const specific = out?.hookSpecificOutput;
  if (specific?.permissionDecision === "deny")
    return String(specific.permissionDecisionReason ?? "blocked by a hook");
  if (out?.decision === "block")
    return String(out.reason ?? "blocked by a hook");
  return undefined;
}

/** SessionStart text: `additionalContext` from JSON output, else plain stdout. */
function contextText(ran: Ran): string {
  if (ran.code !== 0) return "";
  const out = json(ran.stdout);
  if (out) return String(out.hookSpecificOutput?.additionalContext ?? "");
  return ran.stdout.trim();
}

/** Two extensions: `tool` before any rewriting of commands, `prompt` after the
 * host's own sections. `session` names the host conversation a hook's
 * `session_id` reports, since Durable ids repeat across host conversations. */
export function createHooks(
  piAgentDir: string,
  session: (id: ConversationId) => string,
  scope: () => Promise<Scope>,
  log: (event: string, fields: Record<string, unknown>) => void,
) {
  // Conversations whose SessionStart ran with no output, which leaves nothing
  // in `shown` to mark it.
  const ranEmpty = new Set<string>();
  const runAll = async (
    event: string,
    found: Command[],
    payload: object,
    cwd: string,
  ) => {
    const base = await scope();
    const results: Ran[] = [];
    for (const command of found) {
      const ran = await run(command, payload, { ...base, cwd });
      if (ran.code !== 0 && ran.code !== 2)
        log("hook_failed", { event, command: command.command, code: ran.code });
      results.push(ran);
    }
    return results;
  };
  const prompt = defineExtension({
    name: "recurse-hooks-prompt",
    sections: [
      section(SECTION, async (input) => {
        const id = session(input.conversationId);
        const shown = input.shown[SECTION];
        if (shown !== undefined)
          return shown.slice(SECTION.length + 3, -(SECTION.length + 4));
        if (ranEmpty.has(id)) return undefined;
        const found = commands(await groups(piAgentDir, "SessionStart"));
        const cwd = input.env?.cwd ?? input.agent.cwd ?? (await scope()).cwd;
        const payload = {
          hook_event_name: "SessionStart",
          session_id: id,
          cwd,
          source: "startup",
        };
        const text = (await runAll("SessionStart", found, payload, cwd))
          .map(contextText)
          .filter(Boolean)
          .join("\n\n");
        if (!text) ranEmpty.add(id);
        return text || undefined;
      }),
    ],
  });
  const tool = defineExtension({
    name: "recurse-hooks",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          const command = call.arguments.command;
          if (call.name !== "bash" || typeof command !== "string") return;
          const key = `recurse.hooks:${call.id}`;
          const prior = await api.memo<{ block: string | null }>(key, context);
          if (prior)
            return prior.block === null ? undefined : { block: prior.block };
          const found = commands(await groups(piAgentDir, "PreToolUse"), BASH);
          if (!found.length) return;
          const { cwd } = await scope();
          const payload = {
            hook_event_name: "PreToolUse",
            session_id: session(api.conversationId),
            cwd,
            tool_name: BASH,
            tool_input: { command },
            tool_use_id: call.id,
          };
          const block =
            (await runAll("PreToolUse", found, payload, cwd))
              .map(blockReason)
              .find((reason) => reason !== undefined) ?? null;
          await api.memo(key, { block }, context);
          return block === null ? undefined : { block };
        },
      }),
    ],
  });
  return { tool, prompt };
}

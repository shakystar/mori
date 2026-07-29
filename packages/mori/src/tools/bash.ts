/**
 * `bash` tool — runs a shell command in a child process rooted at the working root.
 *
 * THIS IS NOT A SANDBOX.
 *
 * A shell tool can read and write anything the host user can. The command string is
 * never parsed for intent, so the path guard used by the file tools does not apply
 * here: `cat ../../etc/passwd` leaves the working root and this module does not stop
 * it. Trying to close that hole with string matching produces a guard that is believed
 * to work and does not — so this module deliberately does not try.
 *
 * What it actually provides, and nothing more:
 * - the child's cwd is pinned to the working root, so relative paths have a known base
 *   (`bash-exec.ts`)
 * - a fixed list of obviously destructive command patterns is refused before execution
 *   (`bash-guard.ts`) — a blocklist, which is a guard against accidents, not against
 *   an adversary
 * - a wall-clock timeout, an output cap, and no stdin, so a command cannot hang or
 *   exhaust memory (`bash-exec.ts`)
 * - mori's own Anthropic credentials are removed from the child environment
 *   (`bash-exec.ts`, see `BASH_STRIPPED_ENV_VARS`) — every other variable is inherited
 *   as-is
 *
 * Do not run this tool against untrusted prompts. Real isolation (container, seccomp,
 * a permission system) is a separate concern and is not implemented here.
 */
import type { AgentTool, BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@earendil-works/pi-ai";
import { blockedReason, findBlockedPattern } from "./bash-guard.js";
import { BASH_DEFAULT_TIMEOUT_MS, formatBashResult, runBash, type BashRunResult } from "./bash-exec.js";
import { textResult } from "./tool-result.js";

export * from "./bash-guard.js";
export * from "./bash-exec.js";

/** Tool name as the model sees it. The preflight hook matches on this. */
export const BASH_TOOL_NAME = "bash";

const bashParameters = Type.Object({
  command: Type.String({ description: "Shell command to run, from the working root." }),
  timeoutMs: Type.Optional(
    Type.Number({
      description:
        `Wall-clock timeout in milliseconds. Defaults to ${BASH_DEFAULT_TIMEOUT_MS} and can only be lowered — ` +
        "a larger value is clamped back to the configured maximum.",
    }),
  ),
});

export interface CreateBashToolOptions {
  /** Maximum wall-clock timeout. The model may request less, never more. */
  timeoutMs?: number;
  maxOutputChars?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Builds the `bash` AgentTool. `root` becomes the child's cwd for every call.
 *
 * Pair it with `createBashBeforeToolCall()` on the Agent — see the module comment for
 * what this tool does and does not protect against.
 */
export function createBashTool(
  root: string = process.cwd(),
  options: CreateBashToolOptions = {},
): AgentTool<typeof bashParameters, BashRunResult> {
  return {
    name: BASH_TOOL_NAME,
    label: "Bash",
    description:
      "Runs a shell command from the working root and returns stdout, stderr and the exit code. " +
      "Not a sandbox: obviously destructive commands are refused, nothing else is restricted. " +
      "Commands are killed at the timeout and long output is truncated. stdin is not connected, " +
      "so interactive commands fail instead of hanging.",
    parameters: bashParameters,
    execute: async (_toolCallId, params: Static<typeof bashParameters>, signal?: AbortSignal) => {
      // The model can ask for a shorter timeout, never a longer one — otherwise a
      // single tool call could park a process for hours.
      const maxTimeoutMs = options.timeoutMs ?? BASH_DEFAULT_TIMEOUT_MS;
      const requested = params.timeoutMs;
      const timeoutMs =
        requested !== undefined && requested > 0 ? Math.min(requested, maxTimeoutMs) : maxTimeoutMs;

      const result = await runBash(params.command, {
        root,
        timeoutMs,
        maxOutputChars: options.maxOutputChars,
        env: options.env,
        signal,
      });

      return textResult(formatBashResult(result), result);
    },
  };
}

/**
 * Preflight hook for `Agent`'s `beforeToolCall`.
 *
 * Returning `{ block: true, reason }` makes the agent loop skip execution and hand the
 * reason to the model as an error tool result — the model can then try something else.
 * It is not raised as an exception and does not end the run.
 *
 * Tool calls other than `bash` pass through untouched.
 */
export function createBashBeforeToolCall(
  toolName: string = BASH_TOOL_NAME,
): (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined> {
  return async (context) => {
    if (context.toolCall.name !== toolName) return undefined;

    const command = (context.args as { command?: unknown } | undefined)?.command;
    if (typeof command !== "string") return undefined;

    const blocked = findBlockedPattern(command);
    if (!blocked) return undefined;

    return { block: true, reason: blockedReason(blocked) };
  };
}

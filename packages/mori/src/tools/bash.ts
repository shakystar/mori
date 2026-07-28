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
 * - a fixed list of obviously destructive command patterns is refused before execution
 *   (see `BASH_BLOCKED_PATTERNS`) — a blocklist, which is a guard against accidents,
 *   not against an adversary
 * - a wall-clock timeout, an output cap, and no stdin, so a command cannot hang or
 *   exhaust memory
 * - mori's own Anthropic credentials are removed from the child environment
 *   (see `BASH_STRIPPED_ENV_VARS`) — every other variable is inherited as-is
 *
 * Do not run this tool against untrusted prompts. Real isolation (container, seccomp,
 * a permission system) is a separate concern and is not implemented here.
 */
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import type { AgentTool, BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@earendil-works/pi-ai";

/** Tool name as the model sees it. The preflight hook matches on this. */
export const BASH_TOOL_NAME = "bash";

/** Default wall-clock limit for one command. Injectable per call. */
export const BASH_DEFAULT_TIMEOUT_MS = 120_000;

/** Per-stream output cap. Output past this is dropped and the result says so. */
export const BASH_MAX_OUTPUT_CHARS = 100_000;

/** Grace period between SIGTERM and SIGKILL when a command overruns its timeout. */
const KILL_ESCALATION_MS = 2_000;

/** How long to keep draining stdio after the child exits before giving up on it. */
const EXIT_DRAIN_MS = 200;

/**
 * Environment variables removed from the child environment.
 *
 * These are the credentials mori itself authenticates with: a command that dumps its
 * environment (or an `env`-reading dependency it invokes) should not walk away with
 * the user's Anthropic key. This is a narrow scrub of *mori's own* secrets — anything
 * else in the parent environment is still inherited, so this is not a general secret
 * firewall.
 */
export const BASH_STRIPPED_ENV_VARS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_ADMIN_KEY",
];

/** One entry of the destructive-command blocklist. */
export interface BlockedCommandPattern {
  /** Stable id, used in the blocked reason and to pin one test per pattern. */
  id: string;
  /** Human-readable explanation handed back to the model. */
  description: string;
  /** Matched against the raw command string. */
  pattern: RegExp;
}

/**
 * Commands refused before execution.
 *
 * The list is data on purpose: it is the single place patterns are declared, and the
 * test suite asserts every id here has a case exercising it. Adding a pattern without
 * a test fails the suite.
 *
 * Scope is deliberately narrow — mistakes that are unrecoverable and have no plausible
 * legitimate form inside a working root. This blocklist is not a security boundary;
 * any of these effects can be reached by a command written differently.
 */
export const BASH_BLOCKED_PATTERNS: readonly BlockedCommandPattern[] = [
  {
    id: "rm-root",
    description: "deletes the filesystem root or the home directory",
    // `rm` with any flags, targeting `/`, `/*`, `~`, `~/*`, `$HOME` or `${HOME}`.
    pattern: /\brm\b(?:\s+-{1,2}\S+)*\s+(?:--\s+)?(?:\/|\/\*|~|~\/\*|\$HOME|\$\{HOME\})(?=\s|$|;|&|\|)/,
  },
  {
    id: "rm-no-preserve-root",
    description: "disables the filesystem-root safety check of rm",
    pattern: /--no-preserve-root\b/,
  },
  {
    id: "rm-system-directory",
    description: "deletes a system directory outside the working root",
    pattern:
      /\brm\b(?:\s+-{1,2}\S+)*\s+(?:--\s+)?\/(?:etc|usr|bin|sbin|boot|lib|lib64|var|sys|proc|dev|root|home)(?:\/\S*)?(?=\s|$|;|&|\|)/,
  },
  {
    id: "dd-to-disk-device",
    description: "writes a raw image over a disk device",
    pattern: /\bdd\b[^\n]*\bof=\/dev\/(?:[shv]d[a-z]|nvme\d|mmcblk\d|disk\d)/,
  },
  {
    id: "redirect-to-disk-device",
    description: "redirects output straight onto a disk device",
    pattern: />{1,2}\s*\/dev\/(?:[shv]d[a-z]|nvme\d|mmcblk\d|disk\d)/,
  },
  {
    id: "mkfs",
    description: "formats a filesystem, destroying everything on the target device",
    pattern: /\bmkfs(?:\.\w+)?\b/,
  },
  {
    id: "fork-bomb",
    description: "fork bomb — spawns processes until the machine stops responding",
    // `:(){ :|:& };:` and renamed variants; the backreference ties the three uses
    // of the same function name together.
    pattern: /(?:^|[\s;&|])([A-Za-z_.:][\w.:]*)\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&\s*;?\s*\}\s*;?\s*\1/,
  },
];

/** A command ran (whatever its exit code). */
export interface BashRunSuccess {
  ok: true;
  command: string;
  /** Exit code, or null when the process was killed by a signal. */
  exitCode: number | null;
  /** Signal that killed the process, if any. */
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** True when the command hit `timeoutMs` and was killed. Output is partial. */
  timedOut: boolean;
  /** Timeout actually applied to this run. */
  timeoutMs: number;
  /** Per-stream output cap actually applied to this run. */
  maxOutputChars: number;
}

/** The command never ran — blocked, or the shell could not be started. */
export interface BashRunFailure {
  ok: false;
  command: string;
  reason: string;
  /** Set when the refusal came from `BASH_BLOCKED_PATTERNS`. */
  blockedPatternId?: string;
}

export type BashRunResult = BashRunSuccess | BashRunFailure;

export interface RunBashOptions {
  /** Working root. The child's cwd is pinned here. Defaults to `process.cwd()`. */
  root?: string;
  /** Wall-clock limit. `0` disables the timeout. Defaults to `BASH_DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Per-stream output cap. Defaults to `BASH_MAX_OUTPUT_CHARS`. */
  maxOutputChars?: number;
  /** Parent environment to derive the child environment from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/** First blocklist entry matching `command`, or undefined. */
export function findBlockedPattern(command: string): BlockedCommandPattern | undefined {
  return BASH_BLOCKED_PATTERNS.find((entry) => entry.pattern.test(command));
}

/** Refusal message handed to the model. Says which rule fired so it can try another way. */
export function blockedReason(entry: BlockedCommandPattern): string {
  return `blocked by mori bash guard [${entry.id}]: ${entry.description}`;
}

/** Parent environment minus mori's own credentials. See `BASH_STRIPPED_ENV_VARS`. */
export function sanitizeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env };
  for (const name of BASH_STRIPPED_ENV_VARS) delete child[name];
  return child;
}

/** Prefer real bash; fall back to `sh` where bash is not installed. */
function resolveShell(): string {
  return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

/**
 * Kills the child's whole process group.
 *
 * The child is spawned detached so it leads its own group; killing the group takes
 * the pipeline and any grandchildren with it. Killing only the shell would leave its
 * children running with the pipes still open.
 */
function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/** Runs `command` under a shell with cwd pinned to the working root. Never throws. */
export async function runBash(command: string, options: RunBashOptions = {}): Promise<BashRunResult> {
  const blocked = findBlockedPattern(command);
  if (blocked) {
    // Defence in depth: the preflight hook is the real gate, but a caller that wires
    // the tool without the hook must not end up with an unguarded shell.
    return { ok: false, command, reason: blockedReason(blocked), blockedPatternId: blocked.id };
  }

  const timeoutMs = options.timeoutMs ?? BASH_DEFAULT_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? BASH_MAX_OUTPUT_CHARS;

  let cwd: string;
  try {
    cwd = realpathSync(options.root ?? process.cwd());
  } catch {
    return { ok: false, command, reason: `working root does not exist: ${options.root}` };
  }

  return await new Promise<BashRunResult>((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let escalationTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let armDrain: () => void = () => {};

    const child = spawn(resolveShell(), ["-c", command], {
      cwd,
      env: sanitizeEnv(options.env),
      // stdin is /dev/null: a command that reads input sees EOF at once instead of
      // blocking until the timeout.
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const kill = (signal: NodeJS.Signals) => {
      if (child.pid !== undefined) killProcessGroup(child.pid, signal);
    };

    const onAbort = () => kill("SIGKILL");

    const settle = (result: BashRunResult) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (drainTimer) clearTimeout(drainTimer);
      options.signal?.removeEventListener("abort", onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolvePromise(result);
    };

    child.once("error", (error) => {
      settle({ ok: false, command, reason: `failed to start shell: ${error.message}` });
    });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      const room = maxOutputChars - stdout.length;
      if (room <= 0) {
        stdoutTruncated = true;
      } else if (chunk.length > room) {
        stdout += chunk.slice(0, room);
        stdoutTruncated = true;
      } else {
        stdout += chunk;
      }
      armDrain();
    });

    child.stderr?.on("data", (chunk: string) => {
      const room = maxOutputChars - stderr.length;
      if (room <= 0) {
        stderrTruncated = true;
      } else if (chunk.length > room) {
        stderr += chunk.slice(0, room);
        stderrTruncated = true;
      } else {
        stderr += chunk;
      }
      armDrain();
    });

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        kill("SIGTERM");
        // A process that ignores SIGTERM still has to die: escalate once.
        escalationTimer = setTimeout(() => kill("SIGKILL"), KILL_ESCALATION_MS);
        escalationTimer.unref?.();
      }, timeoutMs);
    }

    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (code: number | null, signalName: NodeJS.Signals | null) => {
      settle({
        ok: true,
        command,
        exitCode: code,
        signal: signalName,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        timeoutMs,
        maxOutputChars,
      });
    };

    // `close` fires once the child exited *and* its pipes drained, which is what we
    // want. If a surviving grandchild holds a pipe open, `close` never comes — so
    // `exit` arms a drain window and finishes regardless. The window restarts on every
    // chunk that still arrives, so a slow but live drain is not cut short.
    child.once("close", (code, signalName) => finish(code, signalName));
    child.once("exit", (code, signalName) => {
      armDrain = () => {
        if (settled) return;
        if (drainTimer) clearTimeout(drainTimer);
        drainTimer = setTimeout(() => finish(code, signalName), EXIT_DRAIN_MS);
        drainTimer.unref?.();
      };
      armDrain();
    });
  });
}

/** Renders a run result as the text block the model reads. */
export function formatBashResult(result: BashRunResult): string {
  if (!result.ok) return `Error: ${result.reason}`;

  const truncationNotice = (stream: string) =>
    `\n[${stream} truncated at ${result.maxOutputChars} characters]`;

  const sections: string[] = [];
  if (result.stdout || result.stdoutTruncated) {
    sections.push(result.stdout + (result.stdoutTruncated ? truncationNotice("stdout") : ""));
  }
  if (result.stderr || result.stderrTruncated) {
    sections.push(`[stderr]\n${result.stderr}` + (result.stderrTruncated ? truncationNotice("stderr") : ""));
  }
  if (result.timedOut) {
    sections.push(`[timed out after ${result.timeoutMs}ms — process killed, output above is partial]`);
  }
  sections.push(
    result.exitCode === null
      ? `[killed by signal ${result.signal ?? "unknown"}]`
      : `[exit code ${result.exitCode}]`,
  );

  return sections.join("\n");
}

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

      return { content: [{ type: "text", text: formatBashResult(result) }], details: result };
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

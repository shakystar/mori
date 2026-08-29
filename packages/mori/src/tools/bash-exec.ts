/**
 * Process execution for the `bash` tool: spawns the command, pins its cwd and
 * environment, enforces the timeout, and collects (and truncates) its output.
 *
 * See the module comment in `bash.ts` for what this does and does not protect against.
 */
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { buildJailedSpawnArgs } from "./bash-jail.js";
import { blockedReason, findBlockedPattern } from "./bash-guard.js";

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
  /**
   * mori#489 — confine the command's writes to `root` at the kernel level (a private
   * mount namespace with every other mount remounted read-only, `bash-jail.ts`), instead
   * of the ordinary "cwd is pinned, everything else is reachable" contract this tool
   * otherwise has (see `bash.ts`'s module comment). Off by default: this is for the bench
   * execution path (`bench/preference-regression/runner.ts`), which runs a model against
   * prompts nobody has reviewed for what tool calls they provoke. The interactive/dev
   * `bash` tool does not set this — a developer session already has, and needs, full
   * host access.
   */
  confineWrites?: boolean;
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

/**
 * Accumulates one output stream up to `maxChars`, dropping anything past the cap
 * instead of growing without bound. Used identically for stdout and stderr.
 */
class TruncatingBuffer {
  private text = "";
  truncated = false;

  constructor(private readonly maxChars: number) {}

  append(chunk: string): void {
    const room = this.maxChars - this.text.length;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    if (chunk.length > room) {
      this.text += chunk.slice(0, room);
      this.truncated = true;
      return;
    }
    this.text += chunk;
  }

  get value(): string {
    return this.text;
  }
}

/** Runs `command` under a shell with cwd pinned to the working root. Never throws. */
export async function runBash(
  command: string,
  options: RunBashOptions = {},
): Promise<BashRunResult> {
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
    const stdout = new TruncatingBuffer(maxOutputChars);
    const stderr = new TruncatingBuffer(maxOutputChars);
    let timedOut = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let escalationTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let armDrain: () => void = () => {};

    const { file, args } = options.confineWrites
      ? buildJailedSpawnArgs(resolveShell(), command, cwd)
      : { file: resolveShell(), args: ["-c", command] };

    const child = spawn(file, args, {
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
      stdout.append(chunk);
      armDrain();
    });

    child.stderr?.on("data", (chunk: string) => {
      stderr.append(chunk);
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
        stdout: stdout.value,
        stderr: stderr.value,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
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
    sections.push(
      `[stderr]\n${result.stderr}` + (result.stderrTruncated ? truncationNotice("stderr") : ""),
    );
  }
  if (result.timedOut) {
    sections.push(
      `[timed out after ${result.timeoutMs}ms — process killed, output above is partial]`,
    );
  }
  sections.push(
    result.exitCode === null
      ? `[killed by signal ${result.signal ?? "unknown"}]`
      : `[exit code ${result.exitCode}]`,
  );

  return sections.join("\n");
}

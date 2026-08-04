/**
 * Where mori's loop meets the memory kernel (#12).
 *
 * The seam is deliberately one-directional: `@mori/kernel` knows nothing about
 * pi-agent-core, so everything pi-shaped — the `AgentEvent` vocabulary, the tool
 * names, the working root, the embedder — is resolved here and handed over as
 * plain parameters. This file is the only place that has to change when the
 * harness's event shape does.
 */

import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createId,
  isPersonalStoreId,
  isValidId,
  observedShell,
  observedWrite,
  projectStoreExists,
  renderMemoryContext,
  SqliteMemoryKernel,
  type Embedder,
  type MemoryContext,
  type ObservedToolCall,
  type ToolCallObserver,
  type TurnQuery,
} from "@mori/kernel";
import {
  getEmbedder,
  resolveEmbeddingsConfig,
  sessionStartEmbeddingsConfig,
} from "../external/embeddings/index.js";
import { BASH_TOOL_NAME } from "../tools/bash.js";
import { resolveWithinRoot } from "../tools/paths.js";
import { maskSecrets } from "./mask-secrets.js";

/** Provenance recorded on every event this harness appends. */
export const MORI_ACTOR = "mori";

/**
 * How each of mori's tools maps onto the kernel's capture vocabulary.
 *
 * Keep in sync with `createMoriTools` (tools/index.ts) — `kernel/index.test.ts`
 * fails if a tool ships without a verdict here, because the silent alternative
 * is a new write tool whose edits never reach memory.
 *
 * `read-only` is a decision, not an omission: read_file/list_dir/grep produce no
 * state change, and capture's whole discipline is that noise in the raw layer is
 * the one thing that cannot be cheaply undone (capture-service's module doc).
 */
const TOOL_CAPTURE: Record<string, ToolCaptureVerdict> = {
  edit_file: "write",
  [BASH_TOOL_NAME]: "shell",
  read_file: "read-only",
  list_dir: "read-only",
  grep: "read-only",
};

/** Which capture family a tool belongs to, or `read-only` for tools that signal nothing. */
export type ToolCaptureVerdict = "write" | "shell" | "read-only";

/** The verdict for a tool name, or undefined for a tool nothing has classified yet. */
export function toolCaptureVerdict(toolName: string): ToolCaptureVerdict | undefined {
  return TOOL_CAPTURE[toolName];
}

function stringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Structured `details` every mori tool's result carries (see `tool-result.ts`).
 * `tool_execution_end.result` is `any` at the pi-agent-core type level — this is
 * the shape mori's own tools (`edit-file.ts`, `bash-exec.ts`) actually put there.
 */
interface ToolResultDetails {
  ok: boolean;
  /** bash only: exit code, or null when the process was killed by a signal. */
  exitCode?: number | null;
  /** bash only: true when the command hit its timeout and was killed. */
  timedOut?: boolean;
}

function resultDetails(result: unknown): ToolResultDetails | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const details = (result as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return undefined;
  const ok = (details as { ok?: unknown }).ok;
  return typeof ok === "boolean" ? (details as ToolResultDetails) : undefined;
}

/**
 * Whether a finished tool call actually succeeded, structurally.
 *
 * `event.isError` alone is not enough (#129): mori's tools never throw, they
 * report failure as a normal, non-error result — `edit_file` returns
 * `{ ok: false, reason }` for an unmatched `oldString`, and `bash` returns
 * `{ ok: true, exitCode: 1, ... }` for a command that ran and failed, or
 * `{ ok: true, timedOut: true, ... }` for one that was killed. All three read
 * as `isError === false` to the harness loop, so the structured result has to
 * be checked directly.
 *
 * A signal-killed process (`exitCode === null`) is treated the same as a
 * timeout — not captured — since the command did not run to completion either
 * way and its effect on the working tree is no more trustworthy than a timeout's.
 */
function toolSucceeded(verdict: ToolCaptureVerdict | undefined, result: unknown): boolean {
  const details = resultDetails(result);
  if (!details || !details.ok) return false;
  if (verdict === "shell") {
    if (details.timedOut) return false;
    if (details.exitCode !== 0) return false;
  }
  return true;
}

/**
 * Builds the `AgentEvent` → capture-candidate mapping.
 *
 * Stateful by necessity: `tool_execution_end` is the event that reports whether
 * the call SUCCEEDED, but only `tool_execution_start` carries the arguments, so
 * the arguments are held per tool-call id until the matching end arrives. Calls
 * that never end (an aborted turn) are dropped at `agent_end`, so the map cannot
 * outlive a run.
 *
 * Only successful calls are captured, which is the memorize behaviour this ports
 * (its filter ran on PostToolUse): a refused destructive command or a failed
 * edit changed nothing, so recording it as a work signal would be a lie. Success
 * is judged from the tool's own structured result (`toolSucceeded`), not just
 * `event.isError` — see that function's doc for why the two diverge.
 */
export function createAgentEventObserver(): ToolCallObserver<AgentEvent> {
  const pending = new Map<string, unknown>();

  return (event: AgentEvent): ObservedToolCall | undefined => {
    if (event.type === "tool_execution_start") {
      if (TOOL_CAPTURE[event.toolName] === undefined) return undefined;
      pending.set(event.toolCallId, event.args);
      return undefined;
    }

    if (event.type === "agent_end") {
      pending.clear();
      return undefined;
    }

    if (event.type !== "tool_execution_end") return undefined;

    const args = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    if (event.isError) return undefined;

    const verdict = TOOL_CAPTURE[event.toolName];
    if (!toolSucceeded(verdict, event.result)) return undefined;

    switch (verdict) {
      case "write": {
        // The PATH, never the tool input as a whole: `edit_file`'s arguments also
        // carry `oldString`/`newString`, and passing the object through would
        // record a file body in the observation's `filePath` (#61 review).
        const filePath = stringArg(args, "path");
        return filePath ? observedWrite({ toolName: event.toolName, filePath }) : undefined;
      }
      case "shell": {
        const command = stringArg(args, "command");
        // Masked here, before the command ever reaches the kernel's append-only
        // event log — see mask-secrets.ts for why that has to happen on this
        // side of the seam.
        return command
          ? observedShell({ toolName: event.toolName, command: maskSecrets(command) })
          : undefined;
      }
      default:
        return undefined;
    }
  };
}

/**
 * The kernel's `renderContext` seam, mori-side: retrieved memory → one pi
 * `AgentMessage` (#5 1/3).
 *
 * Split exactly where the seam is. The TEXT comes from the kernel's own
 * `renderMemoryContext` — what a consolidated memory or an observation means is
 * kernel vocabulary, and every harness would otherwise invent its own labels for
 * it. Only the ENVELOPE is decided here, and mori's is a plain user message:
 * pi-agent-core keeps one `systemPrompt` string on the agent state (it is not
 * part of `messages`), and the tool-result and assistant roles are structurally
 * wrong for it, so `user` is the only role a transformed context can occupy.
 *
 * The header `renderMemoryContext` writes is what keeps that from reading as
 * something the user typed.
 */
export function renderContextMessage(context: MemoryContext): AgentMessage {
  return { role: "user", content: renderMemoryContext(context), timestamp: Date.now() };
}

/** Where a project's committed identity lives, relative to its working root (#217). */
const IDENTITY_DIR_NAME = ".mori";
const IDENTITY_FILE_NAME = "project.json";

/**
 * What reading `.mori/project.json` found — distinguished so a caller can tell
 * "no file, mint a path hash" apart from "a file exists but is not usable,"
 * which `createMoriKernel` has to treat differently (the latter must never be
 * overwritten; see `persistProjectIdentity`).
 */
type IdentityFileState = { kind: "valid"; id: string } | { kind: "missing" | "invalid" };

function readIdentityFile(root: string): IdentityFileState {
  // Resolved through the same lstat-based guard the write path uses, and for
  // the same reason: `project.json` itself (not just `.mori`) can be a
  // committed symlink. A plain `readFileSync` below would follow it wherever
  // it points — including outside `root` to a device like `/dev/zero`, whose
  // read never reaches EOF and hangs mori at startup (#217 review round 3).
  // `resolveWithinRoot` rejects that (and a dangling link) before any read
  // happens; a rejection here means "a file is there but unusable," same as
  // any other read failure below, so it falls to `invalid`, not `missing`.
  const guard = resolveWithinRoot(root, path.join(IDENTITY_DIR_NAME, IDENTITY_FILE_NAME));
  if (!guard.ok) return { kind: "invalid" };

  let raw: string;
  try {
    raw = readFileSync(guard.resolved, "utf8");
  } catch (error) {
    // Only ENOENT means "no file" — the missing branch is what lets
    // `createMoriKernel` mint+persist the path hash. Any other read failure
    // (EACCES, EISDIR, ...) means a file is THERE and could be a person's
    // commit, so it must fall to "invalid" and go through the never-overwrite
    // path, not be silently replaced (#217 PR #229 review).
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid" };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const id =
      typeof parsed === "object" && parsed !== null ? (parsed as { id?: unknown }).id : undefined;
    // The `personal_` namespace is reserved for the kernel's own personal
    // stores (`getProjectRoot` routes it to a per-account personal root, not
    // `projects/<id>/`). A committed file cannot be allowed to mint that
    // routing for a project: it would open a project checkout onto an
    // account's personal memory (#155 is the same bug at the identity layer
    // instead of the path layer — see #217 PR #229 review).
    if (typeof id === "string" && isValidId(id) && !isPersonalStoreId(id)) {
      return { kind: "valid", id };
    }
  } catch {
    // Malformed JSON falls through to "invalid" below, same as a well-formed
    // file whose id fails the kernel's ID_PATTERN or names a reserved
    // namespace.
  }
  return { kind: "invalid" };
}

/**
 * The id `moriProjectId` minted before #217: a hash of the resolved path.
 *
 * Still the fallback for every root without a (usable) identity file, and
 * still what gets written into a fresh one — this is the "adopt" side of the
 * migration-free rule (#217): an existing checkout's store path never moves,
 * the file only pins the value down for next time.
 *
 * A hash rather than the path itself because the id is also a directory name
 * and has to satisfy the kernel's `ID_PATTERN`.
 */
function pathHashProjectId(root: string): string {
  const digest = createHash("sha256").update(root).digest("hex");
  return `proj_${digest.slice(0, 16)}`;
}

interface ResolvedProjectIdentity {
  id: string;
  fileState: IdentityFileState["kind"];
}

function resolveProjectIdentity(root: string): ResolvedProjectIdentity {
  const state = readIdentityFile(root);
  return state.kind === "valid"
    ? { id: state.id, fileState: "valid" }
    : { id: pathHashProjectId(root), fileState: state.kind };
}

/**
 * Longest query mori will derive from a turn.
 *
 * The query is not a message — it is a retrieval key that reaches an FTS `MATCH`
 * and (when embeddings are configured) one network embed against the kernel's
 * `SESSION_START_EMBED_TIMEOUT_MS` budget, now once per retrieving turn rather
 * than once per session. A pasted stack trace or file body as a query buys no
 * relevance for either channel and costs both, so the head of the message —
 * where a request states what it is about — is what gets used.
 */
export const MAX_QUERY_CHARS = 512;

/**
 * The kernel's `readQuery` seam, mori-side: this turn's conversation → the
 * retrieval query (#5 2/3-b). The mirror of {@link renderContextMessage}, and
 * split at the same place: the kernel decides what to do with a query, mori
 * decides which part of ITS message vocabulary is one.
 *
 * The most recent user message is the whole derivation. It is the only message
 * that states, in the user's own words, what is being asked right now —
 * assistant turns and tool results describe what mori itself just did, so
 * retrieving on them would ask memory about mori's own last move rather than
 * about the task. No LLM (#215 non-scope), and nothing accumulated across
 * turns: the kernel already treats a repeat of the same ask as "nothing new to
 * retrieve", which only holds if the same question produces the same string.
 *
 * The `turnId` is what makes that cache safe to keep — see the kernel's
 * `TurnQuery` for why one is required. Mori's is the pair (how many user
 * messages exist, when the last one arrived), and each half covers the other's
 * blind spot. Both are constant for the whole of one turn: pi appends tool
 * results with role `toolResult`, and the message this seam's own injection
 * produces never enters `Agent.messages` (`transformContext`'s return value is
 * a local in pi's `streamAssistantResponse`), so nothing a turn does to itself
 * changes either half. Across turns the count moves — except after a `/clear`
 * or a context compaction, which reset or shrink it, and there the timestamp
 * moves instead. The timestamp alone would tie only if two prompts landed in
 * the same millisecond, and then the count separates them.
 *
 * Secrets are masked with the same list `observedShell` uses, because the same
 * argument applies one step further out: a credential the user pasted into the
 * prompt would otherwise be sent verbatim to the embeddings endpoint, which is
 * a different destination from the model the message was addressed to. Masking
 * runs BEFORE the length cap, never after — a cap applied first can cut a
 * credential's value in two and hand the mask a fragment it no longer
 * recognises as one.
 *
 * Returns undefined when the tail holds no user text at all (the first
 * `transformContext` of a run, before the prompt is appended) — the kernel
 * reads that as "no query this turn" and falls back to the session-start
 * injection.
 */
export function readTurnQuery(messages: AgentMessage[]): TurnQuery | undefined {
  let latest: Extract<AgentMessage, { role: "user" }> | undefined;
  let userMessages = 0;
  for (const message of messages) {
    if (message.role !== "user") continue;
    userMessages += 1;
    latest = message;
  }
  if (!latest) return undefined;
  const text = userMessageText(latest.content).trim();
  if (!text) return undefined;
  return {
    query: maskSecrets(text).slice(0, MAX_QUERY_CHARS),
    turnId: `${userMessages}:${latest.timestamp}`,
  };
}

/** A user message's text, whether pi carries it as a string or content blocks. */
function userMessageText(content: Extract<AgentMessage, { role: "user" }>["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Store id for a working root: stable across runs (same checkout ⇒ same memory)
 * and distinct across checkouts (two repos never share a store).
 *
 * Deriving it here and not in the kernel is the seam discipline — "which
 * project am I" is a harness question (#217, unchanged from the original
 * hash-only version). Read-only: a committed `.mori/project.json` (see
 * `readIdentityFile`) takes precedence when its id is usable, otherwise this
 * falls back to `pathHashProjectId` — the same value this function always
 * returned. It never writes; only `createMoriKernel` does that.
 */
export function moriProjectId(root: string): string {
  return resolveProjectIdentity(path.resolve(root)).id;
}

/**
 * Whether a working root's store already exists on disk. A session-end boundary uses this
 * to tell "nothing to consolidate" apart from "consolidation unconfigured" (#107 review):
 * if this session captured anything, `observe`'s own `ensureGenesis` would already have
 * created the store, so "no store" here means no observation has ever passed the capture
 * filter for this root — there is nothing to distill, and running one anyway would be the
 * first write of a session that only read files.
 */
export function moriStoreExists(root: string): boolean {
  return projectStoreExists(moriProjectId(root));
}

/**
 * Whether a store already exists for an id a caller already has in hand — the
 * kernel's own `projectId` (see {@link MoriKernelHandle}), never a fresh
 * `moriProjectId(root)` read (#230).
 *
 * `moriStoreExists(root)` re-resolves identity from disk at call time, which is
 * exactly the seam #230 closes: a session-end boundary asking "does the store
 * THIS session captured into exist" must check the id the kernel actually
 * captured under, not whatever `.mori/project.json` currently holds — the two
 * can differ if the file changed after the kernel was constructed (a
 * `git checkout`, another mori session's `persistProjectIdentity`, or this
 * fleet's own worktree switch between issues).
 */
export function moriStoreExistsForId(projectId: string): boolean {
  return projectStoreExists(projectId);
}

export interface CreateMoriKernelOptions {
  /** Working root; identifies the store and titles its genesis. Defaults to cwd. */
  root?: string;
  /** Env the embedder is configured from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Semantic index seam, in place of the env-configured one. Absent AND
   * unconfigured ⇒ the kernel degrades to FTS-only, which is not an error.
   */
  embedder?: Embedder;
  /**
   * Session this kernel's observations and consolidation boundary belong to.
   * Defaults to a freshly minted id — one kernel is built per CLI process
   * invocation (`prepareAgent`, once for `runPrompt`, once for the whole
   * `runRepl` lifetime), so "one kernel" and "one session" are the same
   * lifetime and a single id minted at construction covers every turn the
   * kernel sees. Overridable so tests can assert on a known id.
   */
  sessionId?: string;
  /**
   * Sink for a capture that failed after the turn moved on. Called at most once
   * per kernel: a store that is broken is broken for every later event, and the
   * agent's output is not a log.
   */
  warn?: (message: string) => void;
}

/**
 * Commits a freshly minted (path-hash) id to `.mori/project.json` so the NEXT
 * run adopts it via `readIdentityFile` instead of re-hashing the path — the
 * "adopt" half of #217: this only ever writes the value the root would have
 * resolved to anyway, so it never mints a new id and never moves a store.
 *
 * Written via a temp file + `link`, not a direct truncating write or a
 * `rename`: two `mori` sessions can start concurrently in the same fresh
 * checkout (two terminals, same repo). Usually both resolve the identical
 * id, but a direct write still lets one process's crash mid-write leave the
 * file torn for the other — which `readIdentityFile` would then read as
 * "invalid" and refuse to touch forever (it treats any on-disk file as
 * possibly human-committed). `rename` would fix that (single filesystem
 * operation) but always succeeds even when `targetPath` already exists,
 * silently overwriting it — and the two writers need not agree: a `git
 * checkout` (or any other process) can publish a genuine, different, valid
 * `project.json` in the window between this call's `resolveProjectIdentity`
 * and this write. `link` fails with `EEXIST` instead of replacing an
 * existing target, so whichever writer gets there first is the one that
 * sticks — the loser's temp file is discarded and the winner's file is
 * never touched (#217 review round 3).
 *
 * Silent on failure (read-only root, no permission): the caller already has
 * a usable id (the path hash), so a write that cannot land degrades to "try
 * again next run," not a broken session — the discipline #217 set for every
 * failure mode here.
 *
 * Guarded by `resolveWithinRoot` (the same lstat-based check `tools/paths.ts`
 * uses for every tool that touches the working tree, #38) before any `mkdir`
 * or write happens: if `.mori` is a symlink whose target resolves outside
 * `root` — something a checked-in tree can carry just as easily as a
 * `project.json` — a naive `mkdirSync`/`writeFileSync` would create/replace a
 * file at that OUTSIDE location the moment mori starts, since `mkdirSync` on
 * an existing directory symlink is a silent no-op and the writes below follow
 * it at the OS level. A blocked resolution degrades exactly like every other
 * failure here: warn and fall back to the in-memory path hash, no throw.
 *
 * Returns the id THIS session must build its kernel with. Usually that is
 * just `id` echoed back, but a losing `link` (`EEXIST`) means some other
 * writer's file is now on disk instead of this session's, and #217 round 3
 * only fixed the file — the id handed back here still ignored that and let
 * `createMoriKernel` open a store under the id it minted in memory, never the
 * winner's (#240). So an `EEXIST` re-reads the winner via `readIdentityFile`
 * and adopts it when usable; every other outcome (write failure, a guard
 * rejection, an unusable or vanished winner) keeps `id`, matching what was
 * already on disk or already decided before this call.
 */
function persistProjectIdentity(root: string, id: string, warn?: (message: string) => void): string {
  const guard = resolveWithinRoot(root, path.join(IDENTITY_DIR_NAME, IDENTITY_FILE_NAME));
  if (!guard.ok) {
    warn?.(`mori: .mori/project.json 기록을 건너뜁니다 — ${guard.reason}\n`);
    return id;
  }
  const targetPath = guard.resolved;
  const tempPath = path.join(
    path.dirname(targetPath),
    `.project.json.${randomBytes(6).toString("hex")}.mori-tmp`,
  );
  let effectiveId = id;
  try {
    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(tempPath, `${JSON.stringify({ id }, null, 2)}\n`, "utf8");
    try {
      linkSync(tempPath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      // Another writer published `targetPath` first (#217 review round 3):
      // `link` never touches an existing target, so its file is exactly what
      // that writer committed. Read it back and adopt it — the file and the
      // id this session opens its store under must never diverge (#240),
      // or this session's observations land in a store no later run's
      // identity resolution will ever find again.
      const winner = readIdentityFile(root);
      if (winner.kind === "valid") {
        effectiveId = winner.id;
      } else if (winner.kind === "invalid") {
        // The file another writer published is unusable. Same never-overwrite
        // rule as the top-level "invalid" branch below: this session keeps
        // its own path hash and leaves the file exactly as it found it.
        warn?.(
          `mori: 경합에서 발행된 .mori/project.json을 읽을 수 없어 경로 해시를 유지합니다 — 파일은 그대로 둡니다.\n`,
        );
      }
      // `winner.kind === "missing"`: the file this call just lost the race to
      // has since vanished. Retrying `link` would be a race-retry loop this
      // issue does not attempt — keep the path hash; the next run resolves
      // identity from scratch and republishes it if still missing.
    }
  } catch (error) {
    warn?.(
      `mori: .mori/project.json 기록 실패 — 다음 실행에서 다시 시도합니다: ${errorText(error)}\n`,
    );
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // best-effort cleanup; tempPath may never have been created
    }
  }
  return effectiveId;
}

/**
 * What `createMoriKernel` hands back: the kernel plus the `projectId` it
 * resolved and pinned at construction (#230).
 *
 * The kernel's own `options.projectId` is private (`SqliteMemoryKernel` is
 * `@mori/kernel`'s, and identity resolution is the harness's job, not the
 * kernel's — #217's seam discipline, unchanged here). A caller that needs to
 * know "which store did THIS session actually capture into" — the session-end
 * boundary, specifically — cannot ask the kernel object for it via the shared
 * `MoriKernel` seam, and must not re-derive it by calling
 * `moriProjectId(root)`/`readIdentityFile` again, because a second read can
 * see a `.mori/project.json` the kernel's own construction already left
 * behind. `projectId` here is that construction-time value, carried alongside
 * the kernel rather than through it.
 */
export type MoriKernelHandle = SqliteMemoryKernel<AgentMessage, AgentEvent> & {
  readonly projectId: string;
};

/**
 * The kernel mori runs. Nothing here is lazy about configuration but everything
 * is lazy about disk: the store's directory and database are created by the
 * first observation that passes the capture filter, so a session that only reads
 * files leaves no trace on disk.
 *
 * Both context seams are wired here, and wiring BOTH is the point (#215): with
 * only `renderContext` the kernel injects once at session start, and the
 * turn-level retrieval it can do would be code that never runs in production.
 *
 * The store lives under the kernel's own root (`~/.mori`, or `MEMORIZE_ROOT`) —
 * resolved inside the kernel's path-resolver from `process.env`, which is why
 * tests that exercise this must set that variable rather than pass an env object.
 *
 * This is also the one point that writes `.mori/project.json` (#217):
 * `moriProjectId`/`moriStoreExists` stay read-only, so the file is only ever
 * touched by the session that actually opens a store. A missing file gets the
 * path hash persisted into it (adopt, see `persistProjectIdentity`); a file
 * that exists but is unusable (parse failure or an id `assertValidId` would
 * reject) is left exactly as a person committed it — this only warns and
 * falls back to the path hash, it never overwrites.
 *
 * The returned handle's `projectId` (#230) is `effectiveId` below, not
 * `identity.id` — the two can differ when `persistProjectIdentity` loses a
 * publish race: the id it minted is a path hash, but another writer's file
 * won the race and is what's on disk, so the kernel (and the id this handle
 * reports) must be built from that winner instead (#240). Whichever value
 * `effectiveId` ends up holding, it is the SAME one wired into the kernel
 * above — a caller reading `projectId` later never re-resolves identity from
 * disk; it only ever reads back what this call already decided.
 */
export function createMoriKernel(options: CreateMoriKernelOptions = {}): MoriKernelHandle {
  const root = path.resolve(options.root ?? process.cwd());
  const warn = options.warn;
  let warned = false;

  const identity = resolveProjectIdentity(root);
  let effectiveId = identity.id;
  if (identity.fileState === "missing") {
    effectiveId = persistProjectIdentity(root, identity.id, warn);
  } else if (identity.fileState === "invalid") {
    warn?.(
      `mori: .mori/project.json을 읽을 수 없어 경로 해시로 대체합니다 — 파일은 그대로 둡니다.\n`,
    );
  }

  // The one construction point for the `Embedder` seam (external/embeddings) —
  // the kernel never builds one and never reads this config.
  const config = resolveEmbeddingsConfig(options.env);
  const embedder = options.embedder ?? getEmbedder(config);
  // A SECOND client over the same config for session-start retrieval, whose
  // budget is the kernel's `SESSION_START_EMBED_TIMEOUT_MS` rather than the
  // consolidation one: memory must never make the first turn wait on the
  // network. An explicitly injected `options.embedder` (tests, alternative
  // providers) serves both — mori cannot re-budget a client it did not build.
  const contextEmbedder = options.embedder ?? getEmbedder(sessionStartEmbeddingsConfig(config));

  const kernel = new SqliteMemoryKernel<AgentMessage, AgentEvent>({
    projectId: effectiveId,
    actor: MORI_ACTOR,
    project: { title: path.basename(root) || root, rootPath: root },
    sessionId: options.sessionId ?? createId("session"),
    observeEvent: createAgentEventObserver(),
    renderContext: renderContextMessage,
    readQuery: readTurnQuery,
    ...(embedder ? { embedder } : {}),
    ...(contextEmbedder ? { contextEmbedder } : {}),
    onCaptureError: (error: unknown) => {
      if (!warn || warned) return;
      warned = true;
      warn(`mori: 메모리 캡처 실패 — 이번 세션의 관찰 기록은 남지 않습니다: ${errorText(error)}\n`);
    },
  });
  return Object.assign(kernel, { projectId: effectiveId });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

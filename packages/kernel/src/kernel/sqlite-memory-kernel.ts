/**
 * The real {@link MemoryKernel}: the ported memorize core (sqlite event log →
 * projections → capture/consolidate services) folded behind the three-method
 * seam. Replaces the placeholder `BufferKernel` as the kernel the harness runs.
 *
 * Deliberately free of pi-* imports, exactly like the seam it implements. The
 * harness owns two things this file will not touch:
 *
 * - **Its event vocabulary.** `observe(event: E)` cannot know what `E` is, so the
 *   harness injects {@link SqliteMemoryKernelOptions.observeEvent}, mapping one
 *   loop event to an {@link ObservedToolCall} (or nothing).
 * - **Its configuration.** `projectId`, `actor`, and the `ConsolidatorLlm` /
 *   `Embedder` / `ConversationSource` seams arrive as parameters; nothing here
 *   reads env or config, and nothing here spawns a process.
 */

import { createProject } from "../domain/entities.js";
import type {
  ConsolidateCallOptions,
  ConsolidatorLlm,
  ConversationSource,
  Embedder,
  MemoryKernel,
} from "../index.js";
import { captureObservation, evaluateCapture } from "../services/capture-service.js";
import {
  consolidate as consolidateBoundary,
  type ConsolidateBoundary,
  type ConsolidateResult,
} from "../services/consolidate-service.js";
import { appendEvent, ensureProjectDirectories, hasGenesisEvent } from "../storage/event-store.js";
import { withProjectLock } from "../storage/project-lock.js";

/**
 * One tool call, in the shape the capture filter reads.
 *
 * `toolInputText` is polymorphic — its meaning depends on the tool family, and
 * getting that wrong is silent and expensive (a write tool handed its whole
 * `tool_input` records the FILE BODY where a path belongs, #61 review). The
 * convention is therefore pinned by the constructors below rather than left to
 * a comment: each takes only the field its family allows, so "write tool + whole
 * tool input" is not expressible.
 */
export interface ObservedToolCall {
  /** Tool name as the harness calls it — recorded verbatim on the observation. */
  readonly toolName: string;
  /** Family-dependent input text: file path / patch body / command. */
  readonly toolInputText: string;
  /** Harness tool-call id, when it has one (dedup provenance). */
  readonly toolUseId?: string;
}

/** A file-writing tool call (`Write` / `Edit` / `edit_file` / …): the PATH, never the body. */
export function observedWrite(call: {
  toolName: string;
  filePath: string;
  toolUseId?: string;
}): ObservedToolCall {
  return {
    toolName: call.toolName,
    toolInputText: call.filePath,
    ...(call.toolUseId ? { toolUseId: call.toolUseId } : {}),
  };
}

/** An `apply_patch`-family call: the RAW PATCH BODY, whose headers name the paths. */
export function observedPatch(call: {
  toolName: string;
  patchBody: string;
  toolUseId?: string;
}): ObservedToolCall {
  return {
    toolName: call.toolName,
    toolInputText: call.patchBody,
    ...(call.toolUseId ? { toolUseId: call.toolUseId } : {}),
  };
}

/** A shell tool call (`Bash` / `bash` / `shell` / …): the COMMAND TEXT. */
export function observedShell(call: {
  toolName: string;
  command: string;
  toolUseId?: string;
}): ObservedToolCall {
  return {
    toolName: call.toolName,
    toolInputText: call.command,
    ...(call.toolUseId ? { toolUseId: call.toolUseId } : {}),
  };
}

/**
 * Maps one harness loop event onto a capture candidate. Returns undefined for
 * every event that is not a completed, successful tool call — chatter, stream
 * deltas, read-only tools, failed calls.
 *
 * Called on the hot path, so it must stay allocation-light and synchronous. It
 * may be stateful (a harness whose "tool finished" event omits the arguments has
 * to remember them from the matching "tool started" event).
 */
export type ToolCallObserver<E> = (event: E) => ObservedToolCall | undefined;

export interface SqliteMemoryKernelOptions<E> {
  /** Store identity — which project's event log this kernel writes to. */
  projectId: string;
  /** Provenance recorded as `actor` on every appended event. */
  actor: string;
  /**
   * Genesis metadata, used ONLY when the log has no `project.created` yet.
   * Absent ⇒ the store is expected to exist already, and a first capture into an
   * ungenesised store fails (reported through {@link onCaptureError}).
   */
  project?: { title: string; rootPath: string };
  /** Session this kernel's observations belong to, when the harness tracks one. */
  sessionId?: string;
  /** The harness's event → capture-candidate mapping. */
  observeEvent: ToolCallObserver<E>;
  /** Semantic index seam, forwarded to consolidation. Absent ⇒ FTS-only. */
  embedder?: Embedder;
  /** Conversation seam, forwarded to consolidation. Absent ⇒ observation-only boundary. */
  conversation?: ConversationSource;
  /** Telemetry label for the boundary this kernel's `consolidate()` represents. */
  boundary?: ConsolidateBoundary;
  /**
   * Sink for a capture that failed in the background. `observe` is fire-and-forget
   * by contract, so a broken store would otherwise fail silently; it must never
   * throw into the agent loop either.
   */
  onCaptureError?: (error: unknown) => void;
}

export class SqliteMemoryKernel<M, E> implements MemoryKernel<M, E> {
  private readonly options: SqliteMemoryKernelOptions<E>;

  /**
   * Serialization chain for queued captures. Appends run one at a time and in
   * observation order, which keeps `seq` (the replay order) matching the order
   * the loop actually did things and keeps concurrent projection rebuilds from
   * racing each other.
   */
  private tail: Promise<void> = Promise.resolve();

  /**
   * Memoized genesis bootstrap — at most one `project.created` per store.
   *
   * Explicitly `| undefined` rather than optional: the memo is CLEARED on a failed
   * bootstrap (see {@link ensureGenesis}), and `exactOptionalPropertyTypes` (#111)
   * rejects assigning `undefined` to an optional property.
   */
  private genesis: Promise<void> | undefined;

  constructor(options: SqliteMemoryKernelOptions<E>) {
    this.options = options;
  }

  /**
   * Passthrough, deliberately. Turn-level retrieval injection is #5's job: doing
   * it here would put the same decision (what to inject, in which message, under
   * what budget) in two places, and this issue's contract is only that the
   * seam's read side exists and stays cheap.
   */
  async transformContext(messages: M[]): Promise<M[]> {
    return messages;
  }

  /**
   * Capture hot path. Two-stage on purpose:
   *
   * 1. The rule-based filter (`evaluateCapture`) runs INLINE and synchronously.
   *    It is pure string matching — no LLM, no network, no disk — so a read-only
   *    tool call costs one regexp sweep and leaves no trace: no queue entry, no
   *    database connection, no promise.
   * 2. Only a passing event queues the append + projection rebuild, which is
   *    async and therefore cannot happen under a synchronous signature. Await it
   *    with {@link drain} (`consolidate` does so itself).
   *
   * Never throws: a mapping or store failure is reported to `onCaptureError` and
   * dropped. Losing an observation degrades memory; throwing here would kill the
   * agent's turn.
   */
  observe(event: E): void {
    let call: ObservedToolCall | undefined;
    try {
      call = this.options.observeEvent(event);
    } catch (error) {
      this.reportCaptureError(error);
      return;
    }
    if (!call) return;
    const observed = call;

    // Pre-filter with the same pure function `captureObservation` applies, so a
    // rejected event never reaches the (async, disk-touching) stage below.
    if (!evaluateCapture(observed.toolName, observed.toolInputText).capture) return;

    this.enqueue(async () => {
      // Genesis and the append+rebuild are ONE critical section across
      // processes (#132). `enqueue` only orders this instance's own captures;
      // a second mori process on the same working root has its own chain and
      // its own connection, and `captureObservation`'s replace-all projection
      // rebuild is a read-modify-write — interleaved, the later commit drops
      // the earlier process's observation from the projection while leaving it
      // in the event log. `ensureGenesis` is inside for the same reason: its
      // `hasGenesisEvent` check and its append are the same shape of race.
      //
      // A lock failure (timeout, unusable lock path) surfaces here as a
      // rejection, which `enqueue` routes to `onCaptureError` — the hot path's
      // no-throw contract holds, and the cost of a lock we cannot take is one
      // dropped observation, not a dead turn.
      await withProjectLock(this.options.projectId, async () => {
        await this.ensureGenesis();
        await captureObservation({
          projectId: this.options.projectId,
          actor: this.options.actor,
          ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
          toolName: observed.toolName,
          toolInputText: observed.toolInputText,
          ...(observed.toolUseId ? { toolUseId: observed.toolUseId } : {}),
        });
      });
    });
  }

  /**
   * Run one consolidation boundary with the injected extraction LLM.
   *
   * Drains first: observations this kernel queued but has not yet appended
   * belong to the window being consolidated, and the watermark would otherwise
   * skip past them until the next boundary.
   *
   * Extractor failure propagates — that is the service's documented contract
   * (the watermark does not advance, so the next boundary retries the same
   * window), and swallowing it here would hide a misconfigured LLM from the
   * boundary caller (#107). A lock failure propagates for the same reason: a
   * boundary that never ran must be visible to whoever asked for it, which is
   * the opposite of `observe`'s contract above.
   *
   * `opts.boundary` (#141), when given, wins over the construction-time
   * `SqliteMemoryKernelOptions.boundary` fallback — the only way one kernel
   * instance can serve two triggers (e.g. session end AND an explicit request)
   * and have each recorded under its own label instead of whichever one was
   * fixed at construction. `opts.signal` is forwarded as-is; see
   * `consolidate-service.ts` for where it is actually checked.
   */
  async consolidate(llm: ConsolidatorLlm, opts?: ConsolidateCallOptions): Promise<void> {
    await this.consolidateWithResult(llm, opts);
  }

  /**
   * `consolidate` plus the service's result, for callers that report on a
   * boundary (counts, resolved extractor, `ok`/`noop`). The seam returns void,
   * so this is the surface the harness reaches for when it wants telemetry.
   */
  async consolidateWithResult(
    llm: ConsolidatorLlm,
    opts?: ConsolidateCallOptions,
  ): Promise<ConsolidateResult> {
    // OUTSIDE the lock, deliberately. `drain()` settles the queued captures,
    // and each of those takes the project lock itself (see `observe`) — draining
    // from inside the lock would make this call wait for work that is waiting
    // for us. The lock therefore starts where the boundary's own
    // read-modify-write does: the watermark read + consolidated append that two
    // processes would otherwise both perform over the same window (#132).
    //
    // Nothing is lost by draining first: the drained captures are appended
    // before the watermark is read, so they are inside this boundary's window
    // exactly as before, and a foreign process that grabs the lock in between
    // consolidates them instead — which is the point of the lock, not a gap.
    await this.drain();
    const boundary = opts?.boundary ?? this.options.boundary;
    return withProjectLock(this.options.projectId, async () => {
      await this.ensureGenesis();
      return consolidateBoundary({
        projectId: this.options.projectId,
        actor: this.options.actor,
        llm,
        ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
        ...(boundary ? { boundary } : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
        ...(this.options.embedder ? { embedder: this.options.embedder } : {}),
        ...(this.options.conversation ? { conversation: this.options.conversation } : {}),
      });
    });
  }

  /**
   * Settle every capture `observe` has queued so far. `observe` is synchronous
   * by contract, so this is the only way a caller can know the store caught up —
   * needed at a boundary (consolidation, session end) and in tests.
   */
  async drain(): Promise<void> {
    // Re-check after awaiting: an `observe` that lands while we wait extends the
    // chain, and "drained" has to mean drained.
    let awaited: Promise<void>;
    do {
      awaited = this.tail;
      await awaited;
    } while (awaited !== this.tail);
  }

  private enqueue(task: () => Promise<void>): void {
    // The chain must survive a failing task, so the recorded tail is the CAUGHT
    // promise — otherwise one broken append would reject every later drain.
    this.tail = this.tail.then(task).catch((error: unknown) => {
      this.reportCaptureError(error);
    });
  }

  private reportCaptureError(error: unknown): void {
    try {
      this.options.onCaptureError?.(error);
    } catch {
      // A failing error sink must not escalate into a failing turn.
    }
  }

  /**
   * Make sure the store has its `project.created` genesis, once per kernel.
   *
   * Everything downstream needs it: `rebuildProjectProjection` throws without
   * one, and the projector anchors self-identity on it. The kernel mints it
   * rather than the harness because the harness would have to reach past the
   * seam into the event log to do so — but the metadata (title, root path) is
   * the harness's, hence `options.project`.
   */
  private async ensureGenesis(): Promise<void> {
    this.genesis ??= (async () => {
      const { projectId } = this.options;
      await ensureProjectDirectories(projectId);
      if (hasGenesisEvent(projectId)) return;

      const meta = this.options.project;
      if (!meta) {
        throw new Error(
          `Project ${projectId} has no project.created event and no genesis metadata was provided`,
        );
      }
      const project = createProject({ title: meta.title, rootPath: meta.rootPath });
      await appendEvent({
        type: "project.created",
        projectId,
        scopeType: "project",
        scopeId: projectId,
        actor: this.options.actor,
        // The genesis id IS the store id — the projector treats a divergent one
        // as an identity clobber (projections/projector.ts).
        payload: { ...project, id: projectId },
      });
    })().catch((error: unknown) => {
      // A failed bootstrap must be retryable: keeping the rejected promise
      // memoized would poison every later capture in this process.
      this.genesis = undefined;
      throw error;
    });
    return this.genesis;
  }
}

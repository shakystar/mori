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
 * - **Its message vocabulary.** `transformContext(messages: M[])` cannot build an
 *   `M` either, so session-start injection is split the same way: the kernel
 *   decides WHAT to inject (retrieval, emptiness, once-per-session), the harness
 *   turns it into a message through {@link SqliteMemoryKernelOptions.renderContext}.
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
import { isEmptyMemoryContext } from "../services/context-render.js";
import { buildMemoryContext, type MemoryContext } from "../services/context-service.js";
import { reinforceInjectedMemories } from "../services/memory-retrieval-service.js";
import {
  appendEvent,
  ensureProjectDirectories,
  hasGenesisEvent,
  projectStoreExists,
} from "../storage/event-store.js";
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

export interface SqliteMemoryKernelOptions<M, E> {
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
  /**
   * The harness's retrieved-context → message mapping, symmetric with
   * {@link observeEvent}: `transformContext` cannot build an `M`, so the harness
   * says what one looks like. Called at most ONCE per kernel, only with a
   * non-empty context, and never with a context this kernel has already
   * injected. `renderMemoryContext` (services/context-render.ts) is the default
   * body for it — a harness normally only wraps that string in its own message
   * shape.
   *
   * ABSENT ⇒ no session-start injection at all, and no retrieval either: a
   * harness that cannot represent the message must not pay for the read.
   *
   * Must not throw. One that does is treated exactly like a failed retrieval
   * (the turn proceeds with the original messages), but it burns the session's
   * single injection.
   */
  renderContext?: (context: MemoryContext) => M;
  /** Semantic index seam, forwarded to consolidation. Absent ⇒ FTS-only. */
  embedder?: Embedder;
  /**
   * Semantic index seam for SESSION-START retrieval, separate from
   * {@link embedder} because their latency budgets are opposites: consolidation
   * embeds whole windows and wants the full HTTP budget, session start runs
   * before the agent's first answer and is capped by
   * `SESSION_START_EMBED_TIMEOUT_MS` (context-service.ts), which the harness
   * bakes into the client it builds.
   *
   * Deliberately NOT falling back to `embedder`: borrowing the consolidation
   * client would put a 20s network call in front of the first turn, which is the
   * exact failure that budget exists to prevent. Absent ⇒ this channel degrades
   * to FTS-only, the documented "works without a key" behaviour.
   */
  contextEmbedder?: Embedder;
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
  private readonly options: SqliteMemoryKernelOptions<M, E>;

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

  /**
   * Whether this kernel has already spent its one session-start retrieval —
   * see {@link transformContext}. "Attempted", not "injected": a retrieval that
   * failed or found nothing is not retried on the next turn, because retrying
   * every turn IS turn-level retrieval (#5 2/3), not this seam.
   */
  private contextAttempted = false;

  constructor(options: SqliteMemoryKernelOptions<M, E>) {
    this.options = options;
  }

  /**
   * Session-start memory injection (#5 1/3).
   *
   * The FIRST call assembles this project's memory context and returns
   * `[rendered, ...messages]`; every later call passes `messages` through
   * untouched. One kernel is one session (mori builds one per CLI process), so
   * "first call" and "session start" are the same moment. TURN-LEVEL retrieval —
   * a fresh query per turn, driven by the conversation — is #5 2/3 and lands on
   * this seam rather than replacing it.
   *
   * NEVER THROWS, for the same reason `observe` does not, only harder: this runs
   * immediately before every LLM call (`transformContext` in pi-agent-core's
   * agent loop, whose own contract is "must not throw or reject"). A failed
   * retrieval degrades the answer; a thrown one kills the turn.
   *
   * Head position is deliberate. The memory block is background for the whole
   * conversation, not a reply to the newest user message, and appending it last
   * would make it the most recent thing said — the strongest position in the
   * context — for text nobody actually typed.
   */
  async transformContext(messages: M[], signal?: AbortSignal): Promise<M[]> {
    const render = this.options.renderContext;
    // No renderer ⇒ the harness cannot represent the message, so do not even
    // read: an injection nobody can express is pure cost.
    if (!render) return messages;
    if (this.contextAttempted) return messages;
    // An already-aborted turn starts nothing AND keeps the attempt: the
    // retrieval never ran, so spending the session's one shot on a cancelled
    // turn would cost the session its context for no work done.
    if (signal?.aborted) return messages;
    // Spend the attempt BEFORE the first await. The loop calls this
    // sequentially today, but the seam promises nothing of the sort, and two
    // overlapping calls that both got past the check above would each inject.
    this.contextAttempted = true;

    // Reading MUST NOT create the store. mori's disk contract is that a session
    // which only reads files leaves no trace on disk (`createMoriKernel`), and
    // this read happens in exactly that session, before any capture — opening
    // the database here would create it for every run.
    if (!projectStoreExists(this.options.projectId)) return messages;

    let context: MemoryContext;
    try {
      // No `taskTitle` (#149 scope): the kernel has no path to one yet, and
      // both channels are designed to degrade to FTS-only without it. Deriving
      // a query from the conversation is 2/3's job.
      context = await buildMemoryContext(this.options.projectId, {
        ...(this.options.contextEmbedder ? { embedder: this.options.contextEmbedder } : {}),
      });
    } catch {
      // Silent, deliberately: the only sink this seam has is `onCaptureError`,
      // which harnesses render as a CAPTURE failure (mori prints exactly that),
      // and mislabelling a retrieval failure is worse than staying quiet. The
      // `memory.injected` event that gives injection its own observability
      // arrives with 2/3.
      return messages;
    }

    // Nothing retrieved ⇒ inject nothing. A bare header would spend tokens and
    // context position telling the model that memory is empty.
    if (isEmptyMemoryContext(context)) return messages;

    let injected: M;
    try {
      injected = render(context);
    } catch {
      return messages;
    }

    // Reinforce AFTER render succeeded, never before (mori#176): stamping
    // `last_accessed_at`/`injection_count` on a memory the model never saw
    // (the render above throws for PR #175's "harness renderer throws" case)
    // would corrupt future CLS ranking with retrieval telemetry for content
    // that was never actually injected. Best-effort and isolated the same way
    // — a reinforcement failure (e.g. a lock held by another process) must not
    // undo the successful render computed above.
    try {
      reinforceInjectedMemories(
        this.options.projectId,
        context.consolidatedMemories?.map((memory) => memory.id) ?? [],
      );
    } catch {
      // best-effort — see comment above.
    }

    return [injected, ...messages];
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
      // #158: the lock's dispossession signal goes straight into the capture,
      // which stops itself before replacing the projection rather than
      // committing a rebuild over a store that is no longer ours. Either way
      // this rejects with `ProjectLockCompromisedError` and `enqueue` reports
      // ONE `onCaptureError` — #132's capture contract, unchanged.
      await withProjectLock(this.options.projectId, async (lockSignal) => {
        await this.ensureGenesis();
        await captureObservation({
          projectId: this.options.projectId,
          actor: this.options.actor,
          ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
          toolName: observed.toolName,
          toolInputText: observed.toolInputText,
          ...(observed.toolUseId ? { toolUseId: observed.toolUseId } : {}),
          signal: lockSignal,
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
   *
   * #158 adds a SECOND cancellation source alongside it — the project lock's
   * own dispossession signal — so a boundary whose lock is taken mid-flight
   * stops at its next commit-adjacent check point instead of running to the end
   * and appending into a window that is no longer this process's to distill.
   * Either signal firing stops the boundary; they reject differently on
   * purpose (`ConsolidateParams.lockSignal`). Propagation is unchanged: a
   * boundary that never ran must be visible to whoever asked for it.
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
    return withProjectLock(this.options.projectId, async (lockSignal) => {
      await this.ensureGenesis();
      return consolidateBoundary({
        projectId: this.options.projectId,
        actor: this.options.actor,
        llm,
        ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
        ...(boundary ? { boundary } : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
        // #158: the second, independent cancellation source — see
        // `ConsolidateParams.lockSignal` for how the two combine and why they
        // reject with different errors.
        lockSignal,
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

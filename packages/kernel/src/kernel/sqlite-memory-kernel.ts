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
 * - **Its message vocabulary.** `transformContext(messages: M[])` can neither
 *   build an `M` nor read one, so context injection is split the same way in
 *   both directions: the kernel decides WHAT to inject (retrieval, emptiness,
 *   duplicate suppression), the harness turns the conversation into a query
 *   through {@link SqliteMemoryKernelOptions.readQuery} and the result into a
 *   message through {@link SqliteMemoryKernelOptions.renderContext}.
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
   * says what one looks like. Called only with a non-empty context, and never
   * with content this kernel has already injected this session (see
   * {@link readQuery} for the turn-level loop and its duplicate policy).
   * `renderMemoryContext` (services/context-render.ts) is the default body for
   * it — a harness normally only wraps that string in its own message shape.
   *
   * ABSENT ⇒ no injection at all, and no retrieval either: a harness that
   * cannot represent the message must not pay for the read.
   *
   * Must not throw. One that does is treated exactly like a failed retrieval
   * (the turn proceeds with the original messages), and the content it refused
   * to render stays un-injected, so a later turn may offer it again.
   */
  renderContext?: (context: MemoryContext) => M;
  /**
   * The harness's conversation → retrieval-query mapping (#5 2/3-b), the exact
   * mirror of {@link renderContext}: `transformContext(messages: M[])` cannot
   * READ an `M` any more than it can build one, so the harness — which owns the
   * message vocabulary — says what this turn is about. Returning undefined (or
   * a blank string) means "nothing to ask this turn".
   *
   * SYNCHRONOUS on purpose. Two reasons, both structural rather than stylistic:
   * it matches {@link observeEvent}, the other seam the kernel calls on the hot
   * path, and it makes the expensive derivation this issue rules out of scope
   * (an LLM call per turn) inexpressible instead of merely discouraged. The
   * budget for talking to a network lives on the {@link contextEmbedder} side of
   * this call, where it is already declared.
   *
   * ABSENT ⇒ today's behaviour exactly (#149): ONE untargeted retrieval at the
   * start of the session, no query, no per-turn re-read. Given, retrieval runs
   * on every turn whose query differs from the one already retrieved — an
   * unchanged query would re-read the same store with the same ranking inputs,
   * and `transformContext` runs before EVERY provider call, not once per user
   * message (a single tool-using turn calls it repeatedly).
   *
   * DUPLICATE SUPPRESSION is the kernel's, not the harness's: content already
   * injected this session is removed from the retrieved context before render,
   * and a context that is left empty injects nothing. Repeating a memory would
   * both waste context and tell the model, falsely, that the repeated thing
   * matters more.
   *
   * Must not throw. One that does is treated as "no injection this turn" — the
   * messages pass through untouched — and costs the session nothing: a later
   * turn where the seam works still gets its retrieval.
   */
  readQuery?: (messages: M[]) => string | undefined;
  /** Semantic index seam, forwarded to consolidation. Absent ⇒ FTS-only. */
  embedder?: Embedder;
  /**
   * Semantic index seam for CONTEXT retrieval, separate from {@link embedder}
   * because their latency budgets are opposites: consolidation embeds whole
   * windows and wants the full HTTP budget, context retrieval runs before an
   * answer the user is waiting on and is capped by
   * `SESSION_START_EMBED_TIMEOUT_MS` (context-service.ts), which the harness
   * bakes into the client it builds. With {@link readQuery} wired that budget
   * is paid per retrieving turn rather than once, which is why an unchanged
   * query does not re-retrieve.
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

/**
 * What {@link SqliteMemoryKernelOptions.readQuery} said about one turn. Three
 * outcomes rather than `string | undefined` because "the harness has nothing to
 * ask" and "the harness broke" must not take the same branch: the first falls
 * back to the untargeted session-start read, the second injects nothing at all
 * (see `transformContext`).
 */
type TurnQuery =
  | { readonly kind: "absent" }
  | { readonly kind: "query"; readonly query: string }
  | { readonly kind: "failed" };

type InjectedObservation = NonNullable<MemoryContext["recentObservations"]>[number];

/**
 * Session-scoped identity of one injectable entry — what duplicate suppression
 * is keyed by, one function per channel so the two sides of the filter (which
 * entries to drop, which keys to record) cannot drift apart.
 *
 * Two channels carry a store id and use it verbatim, namespaced so a memory and
 * a segment can never collide. `recentObservations` has no id to use:
 * `MemoryContext` projects an observation down to the fields a renderer needs
 * and drops the id, and widening `StartupContextPayload` to carry one belongs
 * to whoever owns that payload. Its projection is used instead — observations
 * are append-only and immutable, so those fields distinguish one observation
 * from another as well as an id would within a session.
 */
const memoryKey = (memory: { id: string }): string => `memory:${memory.id}`;
const segmentKey = (segment: { id: string }): string => `segment:${segment.id}`;
const observationKey = (observation: InjectedObservation): string =>
  [
    "observation",
    observation.createdAt,
    observation.signal,
    observation.toolName ?? "",
    observation.summary ?? "",
  ].join("|");

/** Every entry of a context, as the keys {@link withoutInjected} matches on. */
function injectionKeys(context: MemoryContext): string[] {
  return [
    ...(context.consolidatedMemories ?? []).map(memoryKey),
    ...(context.rawSegments ?? []).map(segmentKey),
    ...(context.recentObservations ?? []).map(observationKey),
  ];
}

/**
 * The same context with every entry this session already injected removed.
 * Channels left empty are dropped rather than kept as `[]`, so the result reads
 * the same way `buildMemoryContext` builds one and `isEmptyMemoryContext`
 * judges it.
 */
function withoutInjected(context: MemoryContext, injected: ReadonlySet<string>): MemoryContext {
  const keep = <T>(entries: T[] | undefined, key: (entry: T) => string): T[] =>
    (entries ?? []).filter((entry) => !injected.has(key(entry)));

  const rawSegments = keep(context.rawSegments, segmentKey);
  const consolidatedMemories = keep(context.consolidatedMemories, memoryKey);
  const recentObservations = keep(context.recentObservations, observationKey);

  return {
    ...(rawSegments.length > 0 ? { rawSegments } : {}),
    ...(consolidatedMemories.length > 0 ? { consolidatedMemories } : {}),
    ...(recentObservations.length > 0 ? { recentObservations } : {}),
  };
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
   * Whether this kernel has already spent its one UNTARGETED retrieval — the
   * session-start read that runs without a query (#149). "Attempted", not
   * "injected": a retrieval that failed or found nothing is not retried, since
   * a second untargeted read would ask the store the identical question.
   *
   * Turn-level retrieval (#5 2/3-b) does not go through this flag — it is
   * gated by {@link lastQuery} instead — but it does SET it: once any retrieval
   * has run, the untargeted session-start read has no separate work left to do.
   */
  private contextAttempted = false;

  /**
   * The query whose retrieval has already run, so an unchanged one does not
   * re-read — see {@link SqliteMemoryKernelOptions.readQuery}. Undefined until
   * the first query-driven retrieval; an untargeted session-start read leaves
   * it alone, so the first real query still retrieves.
   */
  private lastQuery: string | undefined;

  /**
   * Identities of everything this kernel has already put in front of the model
   * (see {@link injectionKey}). Turn-level retrieval re-reads a store that
   * mostly has not changed, so without this the same memory would be injected
   * every turn — spending context and telling the model, by sheer repetition,
   * that the repeated item is the important one.
   *
   * Grows only on a SUCCESSFUL render, for the same reason reinforcement and
   * `memory.injected` do (#176): this records what the model actually saw.
   */
  private readonly injected = new Set<string>();

  constructor(options: SqliteMemoryKernelOptions<M, E>) {
    this.options = options;
  }

  /**
   * Memory injection before an LLM call: session start (#5 1/3) and, once the
   * harness supplies {@link SqliteMemoryKernelOptions.readQuery}, every turn
   * whose query is new (#5 2/3-b).
   *
   * A retrieving call assembles this project's memory context and returns
   * `[rendered, ...messages]`; every other call passes `messages` through
   * untouched. Which calls retrieve:
   *
   * - **No `readQuery`** — the first call only. One kernel is one session (mori
   *   builds one per CLI process), so "first call" and "session start" are the
   *   same moment.
   * - **`readQuery` given, no query this turn** — the session-start read, still
   *   at most once: the first turn may well have nothing to ask with, and the
   *   project context that turn injects is 1/3's behaviour, not a fallback.
   * - **`readQuery` given, a query this turn** — retrieve, unless that same
   *   query already retrieved (see {@link lastQuery}).
   *
   * What a retrieving turn may INJECT is narrower than what it retrieves:
   * anything already injected this session is dropped first ({@link injected}),
   * and a context left empty by that injects nothing.
   *
   * NEVER THROWS, for the same reason `observe` does not, only harder: this runs
   * immediately before every LLM call (`transformContext` in pi-agent-core's
   * agent loop, whose own contract is "must not throw or reject"). A failed
   * retrieval degrades the answer; a thrown one kills the turn. That covers the
   * two harness seams it calls too — a `readQuery` or `renderContext` that
   * throws costs this turn its injection and nothing else.
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
    // An already-aborted turn starts nothing AND spends nothing: the retrieval
    // never ran, so charging a cancelled turn for it would cost the session
    // context it never got.
    if (signal?.aborted) return messages;

    const turn = this.deriveQuery(messages);
    // A seam that threw is not a licence to substitute a different retrieval
    // policy — the harness asked for a query-driven read and could not say
    // what to read. Nothing is spent, so the next turn tries again.
    if (turn.kind === "failed") return messages;
    if (turn.kind === "absent") {
      if (this.contextAttempted) return messages;
    } else if (turn.query === this.lastQuery) {
      // Same question, same store, same ranking inputs — and this seam runs
      // before EVERY provider call, so a tool-using turn would otherwise
      // re-read (and re-embed) once per tool call for content the duplicate
      // filter below would then discard anyway.
      return messages;
    }
    // Spend the attempt BEFORE the first await. The loop calls this
    // sequentially today, but the seam promises nothing of the sort, and two
    // overlapping calls that both got past the checks above would each retrieve.
    this.contextAttempted = true;
    if (turn.kind === "query") this.lastQuery = turn.query;

    // Reading MUST NOT create the store. mori's disk contract is that a session
    // which only reads files leaves no trace on disk (`createMoriKernel`), and
    // this read happens in exactly that session, before any capture — opening
    // the database here would create it for every run.
    if (!projectStoreExists(this.options.projectId)) return messages;

    let context: MemoryContext;
    try {
      // The derived query IS the `taskTitle` the retrieval services rank by —
      // it turns on the semantic path in `retrieveMemoryContext` and the
      // `rawSegments` channel, both of which degrade to FTS-only (or to
      // nothing, for segments) without one. Absent, this is the untargeted
      // session-start read #149 shipped.
      context = await buildMemoryContext(this.options.projectId, {
        ...(turn.kind === "query" ? { taskTitle: turn.query } : {}),
        ...(this.options.contextEmbedder ? { embedder: this.options.contextEmbedder } : {}),
      });
    } catch {
      // Silent, deliberately: the only sink this seam has is `onCaptureError`,
      // which harnesses render as a CAPTURE failure (mori prints exactly that),
      // and mislabelling a retrieval failure is worse than staying quiet. A
      // failed retrieval never reaches render, so it never reaches the
      // `memory.injected` append below either — nothing to observe about an
      // injection that didn't happen.
      return messages;
    }

    // Duplicate suppression (#5 2/3-b): a turn injects only what this session
    // has not already shown. Turn-level retrieval re-reads a store that has
    // barely changed, so the pool it returns is mostly last turn's pool; the
    // filter is what keeps "retrieve every turn" from meaning "repeat every
    // turn". Applied BEFORE the emptiness check below, so a turn whose whole
    // result is already-seen content injects nothing at all rather than a
    // header over an empty list.
    const fresh = withoutInjected(context, this.injected);

    // Nothing retrieved ⇒ inject nothing. A bare header would spend tokens and
    // context position telling the model that memory is empty.
    if (isEmptyMemoryContext(fresh)) return messages;

    let injected: M;
    try {
      injected = render(fresh);
    } catch {
      return messages;
    }

    // Only NOW is this content "shown". A render that threw leaves the keys
    // unrecorded on purpose: nothing reached the model, so a later turn is
    // free to offer the same content again.
    //
    // Filter → render → record runs with no await in between, which is what
    // makes the pair safe for the overlapping calls the checks above warn
    // about: two turns can be inside `buildMemoryContext` at once, but the
    // first to come back finishes recording before the second resumes and
    // filters, so they cannot both inject the same entry.
    for (const key of injectionKeys(fresh)) this.injected.add(key);

    // Reinforce AFTER render succeeded, never before (mori#176): stamping
    // `last_accessed_at`/`injection_count` on a memory the model never saw
    // (the render above throws for PR #175's "harness renderer throws" case)
    // would corrupt future CLS ranking with retrieval telemetry for content
    // that was never actually injected. Best-effort and isolated the same way
    // — a reinforcement failure (e.g. a lock held by another process) must not
    // undo the successful render computed above. Reads `fresh`, not `context`:
    // the memories filtered out above were not shown THIS turn (they were
    // stamped by the turn that did show them).
    try {
      reinforceInjectedMemories(
        this.options.projectId,
        fresh.consolidatedMemories?.map((memory) => memory.id) ?? [],
      );
    } catch {
      // best-effort — see comment above.
    }

    // Injection's own observability (#5 2/3-a, mori#214): same condition as
    // reinforcement above, for the same reason — an append here records that
    // the model actually saw this content, not merely that retrieval found
    // it. Best-effort and isolated the same way: a store that cannot take
    // this append (e.g. a lock held by another process) must not undo the
    // injection already computed and about to be returned below.
    //
    // One append per INJECTING turn, not per session (#5 2/3-b): the condition
    // is unchanged, it is just that more turns now meet it. `fresh` again, for
    // the reason reinforcement uses it — the event says what this turn put in
    // front of the model.
    try {
      await appendEvent({
        type: "memory.injected",
        projectId: this.options.projectId,
        scopeType: "session",
        scopeId: this.options.sessionId ?? this.options.projectId,
        actor: this.options.actor,
        payload: {
          memoryIds: fresh.consolidatedMemories?.map((memory) => memory.id) ?? [],
        },
      });
    } catch {
      // best-effort — see comment above.
    }

    return [injected, ...messages];
  }

  /**
   * Ask the harness what this turn is about, without letting it break the turn.
   *
   * Blank is the same as absent — a query of whitespace would turn on the
   * relevance paths with nothing to match, which is strictly worse than the
   * untargeted read it would displace.
   */
  private deriveQuery(messages: M[]): TurnQuery {
    const readQuery = this.options.readQuery;
    if (!readQuery) return { kind: "absent" };
    let query: string | undefined;
    try {
      query = readQuery(messages);
    } catch {
      return { kind: "failed" };
    }
    const trimmed = query?.trim();
    return trimmed ? { kind: "query", query: trimmed } : { kind: "absent" };
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

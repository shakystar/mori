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

import { createProject, type InjectionBudgetDrop } from "../domain/entities.js";
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
  isDuplicateGenesisError,
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
   * on every turn except a repeat of the one already retrieved — the cache key
   * is the whole {@link TurnQuery}, turn identity included, for the reason that
   * type documents.
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
  readQuery?: (messages: M[]) => TurnQuery | undefined;
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
 * What the harness's {@link SqliteMemoryKernelOptions.readQuery} says about one
 * turn: what to retrieve, and which turn is asking.
 *
 * `turnId` is required, because the query alone cannot answer the question the
 * kernel has to ask before spending a read — "have I already retrieved for
 * this?". This seam runs before EVERY provider call, so one turn that uses
 * twenty tools asks the same question twenty-one times, and re-reading each
 * time costs an FTS query plus (with {@link SqliteMemoryKernelOptions.
 * contextEmbedder} configured) a network embed, for content duplicate
 * suppression then drops anyway. Keyed on the query ALONE, though, that same
 * cache cannot tell those repeats apart from a user who typed `continue` twice:
 * the second `continue` is a new turn, with the first one's observations now in
 * the store, and it would silently retrieve nothing at all — turn-level
 * retrieval switched off by the most ordinary follow-up an agent REPL has.
 * Only the harness can tell the two cases apart (the kernel cannot read an
 * `M` — the same premise this seam exists for), so the harness names the turn
 * and the pair is the cache key.
 *
 * Any value that is CONSTANT within one turn and different in the next will do:
 * the kernel only ever compares it for equality, and never parses, stores, or
 * orders it.
 */
export interface TurnQuery {
  /** What this turn is about. Blank or whitespace reads as "nothing to ask". */
  readonly query: string;
  /**
   * Identity of the turn asking — see above. Blank names no turn, so every
   * call retrieves: the cache degrades to off rather than to always-hit.
   */
  readonly turnId: string;
}

/**
 * What {@link SqliteMemoryKernelOptions.readQuery} said, as `transformContext`
 * branches on it. Three outcomes rather than `TurnQuery | undefined` because
 * "the harness has nothing to ask" and "the harness broke" must not take the
 * same branch: the first falls back to the untargeted session-start read, the
 * second injects nothing at all.
 */
type DerivedQuery =
  | { readonly kind: "absent" }
  | { readonly kind: "query"; readonly turn: TurnQuery }
  | { readonly kind: "failed" };

/**
 * A retrieval that has already run, as the calls after it see it: which turn
 * asked (undefined for the untargeted session-start read), and the block that
 * read rendered.
 *
 * The block is kept because a rendered injection lives for exactly ONE provider
 * request. `transformContext`'s return value is a local in pi's agent loop —
 * `context.messages` is never reassigned from it — so nothing this seam
 * prepends survives into the next call, and the model has no state of its own
 * to remember it by. A turn that uses twenty tools reaches this seam twenty-one
 * times and must carry the block every one of them, or it loses its memory
 * context the moment it starts working. Skipping the READ is the saving a
 * repeat call can take; skipping the injection is not.
 *
 * Boxed rather than a bare `M | undefined`, because `M` is the harness's
 * message type and may itself admit `undefined`: "this retrieval injected
 * nothing" has to stay distinguishable from "it injected a message that is
 * undefined".
 */
interface TurnRetrieval<M> {
  readonly turn: TurnQuery | undefined;
  injected: { readonly message: M } | undefined;
}

/**
 * Whether this call is the SAME turn asking the SAME thing as the retrieval
 * that already ran — the only case turn-level retrieval skips the STORE. It
 * still injects: the skipped read's block is re-attached instead (see
 * {@link TurnRetrieval}). Both halves must match: the turn alone would skip a
 * genuine re-ask inside one turn, and the query alone would skip a new turn
 * that repeats familiar words (`continue`).
 */
function isRepeatCall<M>(turn: TurnQuery, last: TurnRetrieval<M> | undefined): boolean {
  // A blank `turnId` names no turn, so it can never establish that this is the
  // same one — two unrelated turns would otherwise match on `"" === ""` and the
  // cache would suppress the retrieval instead of the repeat. The two ways to
  // be wrong here are not symmetric: erring toward re-reading costs one extra
  // query, while a false match silently switches turn-level retrieval off,
  // which is the failure this key exists to prevent.
  if (!turn.turnId) return false;
  const asked = last?.turn;
  return asked !== undefined && asked.turnId === turn.turnId && asked.query === turn.query;
}

/** The memories in a context — what a turn that renders it puts in front of the model. */
function injectedMemoryIds(context: MemoryContext): string[] {
  return (context.consolidatedMemories ?? []).map((memory) => memory.id);
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
   * gated by {@link lastRetrieval} instead — but it does SET it: once any
   * retrieval has run, the untargeted session-start read has no separate work
   * left to do.
   *
   * A retrieval CANCELLED mid-flight gives it back, provided no later call has
   * claimed it since (see `transformContext`): nothing reached the model, so
   * the session-start read still has its work.
   *
   * CONVERSATION-scoped, not session-scoped: {@link resetConversation} clears
   * it (#234). Without that, mori's `/clear` would leave it `true` forever —
   * set by the conversation `/clear` just threw away — and the new
   * conversation's first turn would silently skip the session-start read that
   * `!readQuery` sessions depend on entirely.
   */
  private contextAttempted = false;

  /**
   * The retrieval that has already run, so a repeat of the same provider call
   * re-attaches its block instead of re-reading, while a genuinely new turn
   * reads again — see {@link TurnRetrieval} and {@link TurnQuery}. Undefined
   * until the first retrieval; a cancelled call restores what it found here.
   *
   * CONVERSATION-scoped, like {@link contextAttempted}: {@link resetConversation}
   * clears it too (#234). Left alone, the previous conversation's last turn
   * would still satisfy `isRepeatCall` for whatever the new conversation's
   * first turn happens to be named, re-attaching a stale block instead of
   * retrieving for a conversation the store has never been asked about.
   */
  private lastRetrieval: TurnRetrieval<M> | undefined;

  /**
   * Ids of the memories this session (this KERNEL INSTANCE — one per mori CLI
   * process) has already REINFORCED. SESSION-scoped, deliberately not touched by
   * {@link resetConversation}: unlike {@link contextAttempted} and
   * {@link lastRetrieval}, what this set gates (how often a stamp that feeds
   * ranking gets written) has nothing to do with which conversation is asking,
   * and clearing it on `/clear` would let a chatty session of short
   * conversations re-stamp the same memory's recency once per conversation
   * instead of once per process — the exact self-reinforcing loop the
   * "once" below exists to prevent.
   *
   * This set does not decide what gets injected. A rendered block lives for one
   * provider request only ({@link TurnRetrieval}), so re-sending a memory the
   * model saw last turn is not a repetition — it is the only way that memory is
   * present at all. What the set decides is how often a send is STAMPED.
   *
   * `reinforceInjectedMemories` writes `last_accessed_at`, which is an input to
   * the very ranking that selected these memories (`buildMemoryContext` decays a
   * memory from its last access, not its creation). Stamping every turn would
   * close that loop on itself: an injected memory would reset its own recency
   * each turn, outrank everything for the rest of the session, and — the stamp
   * being a projection that survives the process — into the sessions after it.
   * Stamped once per session per memory, reinforcement keeps saying what it
   * reads as: this memory was surfaced on this occasion.
   *
   * `injection_count`, which `touchMemoryAccess` bumps in the same statement,
   * therefore counts OCCASIONS as well — sessions in which a memory was
   * surfaced. Not provider calls, and not turns.
   *
   * Grows only on a SUCCESSFUL render, for the same reason reinforcement and
   * `memory.injected` do (#176): a memory the model never saw must stay free
   * for the turn that does show it to stamp.
   */
  private readonly reinforced = new Set<string>();

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
   * - **`readQuery` given, a query this turn** — retrieve, unless this same
   *   turn already retrieved that same query (see {@link lastRetrieval}), in
   *   which case that retrieval's block is re-attached without a second read.
   *
   * A CANCELLED call retrieves but records nothing: an aborted turn's messages
   * never reach the model, so it must not consume the session's attempt, fill
   * the block cache, stamp reinforcement, or claim an injection in telemetry.
   *
   * A turn injects everything its retrieval returned. Nothing is withheld for
   * having been shown before, because nothing shown before is still there —
   * see {@link TurnRetrieval} for the one-request lifetime that makes
   * re-injection the norm rather than a duplicate.
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
    } else if (isRepeatCall(turn.turn, this.lastRetrieval)) {
      // The SAME turn asking the same thing again: same store, same ranking
      // inputs, so the READ is skipped. This seam runs before every provider
      // call, and a tool-using turn would otherwise re-read (and re-embed) once
      // per tool call for a context that cannot have moved.
      //
      // The INJECTION is not skipped. The block that read rendered is prepended
      // again, because it is gone from everything else — it lived in one
      // provider request and nothing carried it forward (see `TurnRetrieval`).
      // Returning `messages` bare here would mean a turn had its project
      // context for its first request and worked without it for the rest.
      //
      // A new turn with the same text is not this case and does retrieve — see
      // `TurnQuery`.
      const cached = this.lastRetrieval?.injected;
      return cached ? [cached.message, ...messages] : messages;
    }
    // Spend the attempt BEFORE the first await. The loop calls this
    // sequentially today, but the seam promises nothing of the sort, and two
    // overlapping calls that both got past the checks above would each retrieve.
    //
    // `claim` is this call's identity as well as its state: the cancellation
    // path below restores only while this exact object is still installed. The
    // untargeted read takes one too, so that it can be told apart the same way;
    // it names no turn, so it never satisfies `isRepeatCall`, and it can only
    // run before any query read has spent `contextAttempted`.
    const spent = { attempted: this.contextAttempted, retrieval: this.lastRetrieval };
    const claim: TurnRetrieval<M> = {
      turn: turn.kind === "query" ? turn.turn : undefined,
      injected: undefined,
    };
    this.contextAttempted = true;
    this.lastRetrieval = claim;

    // Reading MUST NOT create the store. mori's disk contract is that a session
    // which only reads files leaves no trace on disk (`createMoriKernel`), and
    // this read happens in exactly that session, before any capture — opening
    // the database here would create it for every run.
    if (!projectStoreExists(this.options.projectId)) return messages;

    let context: MemoryContext;
    let dropped: InjectionBudgetDrop[];
    try {
      // The derived query IS the `taskTitle` the retrieval services rank by —
      // it turns on the semantic path in `retrieveMemoryContext` and the
      // `rawSegments` channel, both of which degrade to FTS-only (or to
      // nothing, for segments) without one. Absent, this is the untargeted
      // session-start read #149 shipped.
      ({ context, dropped } = await buildMemoryContext(this.options.projectId, {
        ...(turn.kind === "query" ? { taskTitle: turn.turn.query } : {}),
        ...(this.options.contextEmbedder ? { embedder: this.options.contextEmbedder } : {}),
      }));
    } catch {
      // Silent, deliberately: the only sink this seam has is `onCaptureError`,
      // which harnesses render as a CAPTURE failure (mori prints exactly that),
      // and mislabelling a retrieval failure is worse than staying quiet. A
      // failed retrieval never reaches render, so it never reaches the
      // `memory.injected` append below either — nothing to observe about an
      // injection that didn't happen.
      return messages;
    }

    // Cancellation is checked AGAIN here, on the far side of the retrieval,
    // because everything below records that the model SAW this content — the
    // block cache, reinforcement, `memory.injected` — while the array this call
    // returns goes nowhere once the provider call it was built for is
    // cancelled. The await it spans is a real window: an FTS read plus, with
    // embeddings configured, a network embed against a multi-second budget, and
    // (#5 2/3-b) it now opens on every retrieving turn rather than once, with
    // Ctrl-C being ordinary rather than exceptional in a REPL.
    //
    // The attempt is REFUNDED rather than left spent, because the alternative
    // lets a cancelled turn take context away from the turns after it: an
    // untargeted read cancelled here would leave `contextAttempted` set and the
    // session would never inject its project context at all. The refund costs
    // at most one repeated read. It mirrors the pre-retrieval check above,
    // which for the same reason refuses to spend rather than spending on a turn
    // that already had nothing to gain.
    //
    // Refunded ONLY while the state is still this call's, though. An
    // overlapping later call may have replaced it during the await, and a
    // snapshot taken before that call started describes a world it has already
    // moved past: restoring it would hand the live turn back a gate it has
    // already passed, so its next provider call would re-read and re-embed for
    // a retrieval that landed. Identity of `claim` is the whole test — the same
    // discipline as spending before the first await, carried to the other end.
    // The cache is not filled here either way, which is the same rule seen from
    // the other side: a cancelled call leaves nothing for a later one to reuse.
    if (signal?.aborted) {
      if (this.lastRetrieval === claim) {
        this.contextAttempted = spent.attempted;
        this.lastRetrieval = spent.retrieval;
      }
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

    // Only NOW is this content "shown". A render that threw records nothing on
    // purpose: it reached no model, so it leaves no block for the rest of the
    // turn to reuse and no memory marked as stamped.
    //
    // Split → render → record runs with no await in between, so two calls that
    // were inside `buildMemoryContext` at once cannot both count the same
    // memory as first-shown: the first to come back finishes recording before
    // the second resumes and splits.
    claim.injected = { message: injected };
    const memoryIds = injectedMemoryIds(context);
    const firstShown = memoryIds.filter((id) => !this.reinforced.has(id));
    for (const id of firstShown) this.reinforced.add(id);

    // Reinforce AFTER render succeeded, never before (mori#176): stamping
    // `last_accessed_at`/`injection_count` on a memory the model never saw
    // (the render above throws for PR #175's "harness renderer throws" case)
    // would corrupt future CLS ranking with retrieval telemetry for content
    // that was never actually injected. Best-effort and isolated the same way
    // — a reinforcement failure (e.g. a lock held by another process) must not
    // undo the successful render computed above.
    //
    // `firstShown`, not `memoryIds` (#5 2/3-b): reinforcement counts occasions,
    // once per session per memory, because the stamp it writes feeds the very
    // ranking that chose these — see `reinforced` for the loop that per-turn
    // stamping would close.
    try {
      reinforceInjectedMemories(this.options.projectId, firstShown);
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
    // One append per INJECTING TURN, not per session (#5 2/3-b) and not per
    // provider call: the condition is unchanged, it is just that more turns now
    // meet it, while a repeat call inside one turn returns from the cache above
    // and never reaches here.
    //
    // The payload is `memoryIds` — everything this turn SENT, including what an
    // earlier turn also sent. It is the opposite grain from reinforcement just
    // above, deliberately: the event answers "what did the model see this
    // turn", and a turn that re-sent a familiar memory reporting `[]` would
    // deny an injection that actually happened.
    //
    // `dropped` (#242 1/2) rides the same append: it is this same retrieval's
    // budget trim, computed once by `buildMemoryContext` above and carried
    // through untouched — not a second read, and not a second judgement about
    // what mattered. Omitted rather than sent as `[]` when nothing was cut,
    // matching how `MemoryContext`'s own channels are conditionally present.
    try {
      await appendEvent({
        type: "memory.injected",
        projectId: this.options.projectId,
        scopeType: "session",
        scopeId: this.options.sessionId ?? this.options.projectId,
        actor: this.options.actor,
        payload: { memoryIds, ...(dropped.length > 0 ? { dropped } : {}) },
      });
    } catch {
      // best-effort — see comment above.
    }

    return [injected, ...messages];
  }

  /**
   * Tell this kernel the harness's CONVERSATION restarted — mori's `/clear`
   * (#234), as opposed to the process ending. Clears exactly the two fields
   * `transformContext` keys on "has THIS CONVERSATION already…": whether it
   * has spent its untargeted session-start read ({@link contextAttempted})
   * and what its last turn retrieved ({@link lastRetrieval}). A fresh
   * conversation has asked neither question yet, so both go back to their
   * constructor defaults.
   *
   * Left alone, on purpose: {@link reinforced} (recency stamps feed ranking,
   * scoped to the process, not the conversation — see that field), `tail`
   * (queued captures are observations the PROCESS made, not the conversation
   * being cleared — `/clear` is not a request to un-observe them), `genesis`,
   * and `sessionId`. None of those answer a "has this conversation…"
   * question, so none of them are this method's to touch.
   *
   * NEVER THROWS: it only assigns fields, the same guarantee `transformContext`
   * itself documents, and for the same reason — a harness command as ordinary
   * as `/clear` must not be able to kill the REPL loop.
   */
  resetConversation(): void {
    this.contextAttempted = false;
    this.lastRetrieval = undefined;
  }

  /**
   * Ask the harness what this turn is about, without letting it break the turn.
   *
   * Blank is the same as absent — a query of whitespace would turn on the
   * relevance paths with nothing to match, which is strictly worse than the
   * untargeted read it would displace.
   */
  private deriveQuery(messages: M[]): DerivedQuery {
    const readQuery = this.options.readQuery;
    if (!readQuery) return { kind: "absent" };
    let asked: TurnQuery | undefined;
    try {
      asked = readQuery(messages);
    } catch {
      return { kind: "failed" };
    }
    const query = asked?.query.trim();
    return asked && query
      ? { kind: "query", turn: { turnId: asked.turnId, query } }
      : { kind: "absent" };
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
   *
   * #236 (#189 B): `hasGenesisEvent` above and this `appendEvent` are not
   * atomic across processes — `withProjectLock` (#132) runs its critical
   * section to completion even after losing the lock, reporting the loss
   * rather than pre-empting it, so two processes bootstrapping the same new
   * store at once can both pass the check and both attempt the append. The
   * database's `idx_events_genesis_once` unique index (db.ts v18) makes the
   * loser's insert fail instead of silently duplicating the row, and that
   * failure is caught here and treated as success: another process having
   * already minted genesis is the expected outcome of losing this race, not
   * a bootstrap failure.
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
      try {
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
      } catch (error) {
        if (!isDuplicateGenesisError(error)) throw error;
      }
    })().catch((error: unknown) => {
      // A failed bootstrap must be retryable: keeping the rejected promise
      // memoized would poison every later capture in this process.
      this.genesis = undefined;
      throw error;
    });
    return this.genesis;
  }
}

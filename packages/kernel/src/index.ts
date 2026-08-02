/**
 * The memory kernel seam. The memorize core (domain / storage / projections /
 * services) gets absorbed behind this surface; the harness only ever talks to
 * `MemoryKernel`.
 *
 * Deliberately free of pi-* imports: the harness instantiates the generic
 * parameters with pi types at the wiring layer, so the kernel stays
 * replaceable and the consolidation LLM stays injected (the extractor-seam
 * inversion — no host CLI, no spawn).
 */

import type { ConsolidateBoundary } from "./services/consolidate-service.js";

export * from "./domain/index.js";
export * from "./kernel/sqlite-memory-kernel.js";
export { projectStoreExists } from "./storage/event-store.js";
export type { ConsolidateBoundary };
/**
 * #169 — the output-token budget the kernel already reserves for the
 * extraction reply (`extractionCharBudget`'s input-side accounting). Exported
 * so an adapter's `ConsolidatorLlm` implementation can cap its OWN provider
 * call at the same number instead of declaring a second, unrelated literal
 * that could silently drift from the one the input budget was sized against.
 */
export { RESERVED_OUTPUT_TOKENS } from "./services/consolidate-service.js";
// Session-start injection (#5 1/3). The harness needs three things to fill the
// `renderContext` seam: the context type, the default text rendering of it, and
// the embed budget it must bake into the client it hands over as
// `contextEmbedder`. Nothing else from `services/` is exported — this is the
// seam's surface, not a door onto the retrieval internals.
export { isEmptyMemoryContext, renderMemoryContext } from "./services/context-render.js";
export { SESSION_START_EMBED_TIMEOUT_MS, type MemoryContext } from "./services/context-service.js";

/** LLM seam for consolidation. The harness supplies an in-process implementation. */
export interface ConsolidatorLlm {
  complete(prompt: string): Promise<string>;
  /**
   * This model's total context window, in tokens — the hard limit the
   * extraction prompt (system + user content) and its reply must fit inside
   * together. Optional (#143 item②): a client that cannot state it (unknown
   * model, a router) leaves this undefined and `consolidate-service` falls
   * back to a fixed, conservative character budget that assumes nothing about
   * the model behind this seam. Declaring it lets the kernel size the prompt
   * to the ACTUAL model instead of that one-size-fits-all default, which a
   * small local model (or a CJK-heavy prompt, whose tokenizer runs far more
   * tokens per character than English) can otherwise overflow.
   *
   * Typed `| undefined` explicitly, not just `?:` — under this package's
   * `exactOptionalPropertyTypes`, a bare `?:` only permits OMITTING the key,
   * not a present key holding `undefined`. The production implementation
   * (`PiConsolidatorLlm`) resolves this from a live model lookup that itself
   * returns `T | undefined` (unknown provider/model id), so the property must
   * accept an explicit `undefined` value, not just absence.
   */
  readonly contextWindowTokens?: number | undefined;
}

/**
 * Per-call options for {@link MemoryKernel.consolidate} (#141). A single optional object,
 * added once in an extensible shape, so a future field does not change the seam's signature
 * again — every existing implementation and caller (including {@link BufferKernel}) keeps
 * compiling unmodified because both fields are optional and the parameter itself is.
 */
export interface ConsolidateCallOptions {
  /**
   * Telemetry label for THIS call, overriding whatever boundary a construction-time option
   * fixed (`SqliteMemoryKernelOptions.boundary`). One kernel instance can serve more than one
   * trigger (session end AND an explicit request share the same instance in mori), so a label
   * fixed once at construction can only ever be right for one of them — this is the per-call
   * value that lets it be right for both.
   */
  boundary?: ConsolidateBoundary;
  /**
   * Cancels the boundary at the extraction-call edge ONLY — consolidation is append-only, so
   * nothing already durable is rewound. An already-aborted signal means the extractor is never
   * invoked and the watermark does not advance, exactly like an extractor failure: the next
   * boundary retries the same window.
   */
  signal?: AbortSignal;
}

/**
 * Embedding seam for semantic search. The harness supplies an in-process
 * implementation (mori: `HttpEmbedder`, an OpenAI-compatible `/embeddings`
 * client configured from `MEMORIZE_EMBEDDINGS_*`) — the kernel never builds one
 * and never reads that config, exactly as with `ConsolidatorLlm`.
 *
 * OPTIONAL throughout: every kernel entry point that takes an `Embedder` accepts
 * `undefined` and degrades to FTS5 lexical search, which is the "works without a
 * key" guarantee. Absence is a caller decision, not an env lookup.
 */
export interface Embedder {
  /** Embed a batch of texts → one vector per input, in input order. */
  embed(texts: string[]): Promise<number[][]>;
  /** Identifies the vector space; a change invalidates stored embeddings. */
  readonly model: string;
}

/**
 * One resumable point inside a {@link ConversationSlice}: "a consumer that was
 * shown (or stored) exactly the first `chars` characters of `text` may commit
 * `offset` as its new cursor".
 *
 * This is what makes PARTIAL consumption expressible without making offsets
 * transparent to the kernel — the kernel never does arithmetic on an offset, it
 * only picks one of the values the source itself declared (#144).
 */
export interface ConversationResumePoint {
  /** Prefix length, in characters of `ConversationSlice.text`. */
  chars: number;
  /** The cursor value that corresponds to consuming exactly that prefix. */
  offset: number;
}

/** One boundary's worth of conversation, as produced by a {@link ConversationSource}. */
export interface ConversationSlice {
  /**
   * The conversational turns since the requested offset, joined by a blank line
   * ("USER: …\n\nAGENT: …"). Empty when the slice held nothing a human said or
   * the agent answered — tool traffic alone is not conversation.
   */
  text: string;
  /**
   * Cursor to hand back on the next boundary. Opaque to the kernel — it never
   * derives one offset from another. It does, however, assume offsets are
   * MONOTONICALLY NON-DECREASING as the conversation grows: the stored
   * watermark is compared against incoming values to tell "moved forward" from
   * "went backwards" (`resumePointsOf`, and the cursor-advance tail in
   * `consolidate-service.ts`). A source whose cursor tokens wrap or otherwise
   * run backwards does not lose content — its points are simply dropped and
   * the slice holds — but it will not drain, so make the value order-comparable
   * (a char/byte count, a turn index, a sequence number).
   */
  newOffset: number;
  /**
   * Points at which a consumer may resume mid-slice, ascending by `chars` and
   * all strictly inside `text` (`0 < chars < text.length`). Cut them at turn
   * boundaries: the kernel shows the extractor `text.slice(0, chars)` verbatim,
   * so a point mid-sentence hands over a fragment.
   *
   * WHY IT EXISTS (#144): the kernel's extraction prompt has a char budget, and
   * a slice bigger than that budget could previously only be consumed WHOLE or
   * not at all. The #136 invariant ("never consume what was neither shown nor
   * stored") then held the cursor forever — every later boundary re-read the
   * same, now larger, slice. With resume points the kernel commits the offset
   * of the prefix it actually showed, so an oversized slice DRAINS across
   * boundaries instead of pinning the conversation axis.
   *
   * EMPTY is legal and means "all-or-nothing" — the pre-#144 contract, for a
   * source that cannot map a text position back to a cursor. Such a source
   * keeps the permanent-hold failure mode, reported as
   * `ConsolidateResult.conversationSliceHeld`. Supply points whenever the
   * offset is derivable from the text (a char/byte index, a turn index, …).
   */
  resumePoints: readonly ConversationResumePoint[];
}

/**
 * Conversation seam for consolidation — the third injected capability, next to
 * `ConsolidatorLlm` and `Embedder` and for the same reason.
 *
 * Consolidation wants the verbatim dialogue since the last boundary: it is both
 * the richest extraction input and the raw material of the `segments` buffer,
 * which exists precisely to keep detail the extractor compressed away. In
 * memorize the kernel got that by opening the host agent's transcript file and
 * parsing its (explicitly unstable) JSONL — a hard dependency on one harness's
 * on-disk format living inside the replaceable core. Inverted here: the harness
 * knows where its conversation lives and hands over already-stripped text, so
 * the kernel keeps the detail without owning any file format. mori's
 * conversation is in-process (`agent.state.messages`), which is exactly the case
 * a transcript-path parameter could not have expressed.
 *
 * OPTIONAL like the other two: absent ⇒ an observation-only boundary, which is
 * the pre-existing degraded behaviour, not an error.
 */
export interface ConversationSource {
  /**
   * Stable identity of this conversation. Keys the per-source byte watermark, so
   * it must survive across boundaries and across sessions sharing one
   * conversation (compaction splits one conversation over several sessions).
   */
  readonly id: string;
  /**
   * Conversation appended after `offset`, or undefined when nothing is new /
   * the source is unreadable. Never throws — an unreadable conversation
   * degrades a boundary, it does not fail it.
   */
  read(offset: number): Promise<ConversationSlice | undefined>;
}

export interface MemoryKernel<M, E> {
  /** Per-turn retrieval: runs right before each LLM call. */
  transformContext(messages: M[], signal?: AbortSignal): Promise<M[]>;
  /** Capture hot path: observes every loop event. Must stay cheap and rule-based. */
  observe(event: E): void;
  /** Distill captured events into long-term memory via the injected LLM. */
  consolidate(llm: ConsolidatorLlm, opts?: ConsolidateCallOptions): Promise<void>;
}

/**
 * TEST-ONLY kernel: passes context through untouched, buffers events in memory,
 * consolidates nothing. Touches no disk and needs no configuration, which is
 * what makes it the right double for tests about the harness (provider
 * selection, the toolset, the REPL loop) that have no interest in memory.
 *
 * It is no longer the kernel mori runs — {@link SqliteMemoryKernel} replaced it
 * in that role (#12). Keep new production wiring off it: a `BufferKernel` in a
 * real code path means events are being dropped on the floor.
 */
export class BufferKernel<M, E> implements MemoryKernel<M, E> {
  readonly events: E[] = [];

  async transformContext(messages: M[]): Promise<M[]> {
    return messages;
  }

  observe(event: E): void {
    this.events.push(event);
  }

  async consolidate(): Promise<void> {}

  /** Nothing to settle — `observe` finished the moment it returned. */
  async drain(): Promise<void> {}
}

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

export * from "./domain/index.js";

/** LLM seam for consolidation. The harness supplies an in-process implementation. */
export interface ConsolidatorLlm {
  complete(prompt: string): Promise<string>;
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

export interface MemoryKernel<M, E> {
  /** Per-turn retrieval: runs right before each LLM call. */
  transformContext(messages: M[], signal?: AbortSignal): Promise<M[]>;
  /** Capture hot path: observes every loop event. Must stay cheap and rule-based. */
  observe(event: E): void;
  /** Distill captured events into long-term memory via the injected LLM. */
  consolidate(llm: ConsolidatorLlm): Promise<void>;
}

/** Placeholder kernel: passes context through untouched, buffers events in memory. */
export class BufferKernel<M, E> implements MemoryKernel<M, E> {
  readonly events: E[] = [];

  async transformContext(messages: M[]): Promise<M[]> {
    return messages;
  }

  observe(event: E): void {
    this.events.push(event);
  }

  async consolidate(): Promise<void> {}
}

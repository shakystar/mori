import { createHash } from "node:crypto";

import { nowIso } from "../domain/common.js";
import type { Embedder } from "../index.js";
import { listValidMemories } from "./projection-store.js";
import { listSegments } from "./segment-store.js";
import { listEmbeddings, upsertEmbedding, type EmbeddingRow } from "./embeddings-store.js";

/**
 * P3-c — semantic search embeddings, kernel side. Mirrors the LLM consolidator
 * seam (`ConsolidatorLlm`): the `Embedder` is INJECTED by the harness, never
 * constructed here. The HTTP client and the `MEMORIZE_EMBEDDINGS_*` env reading
 * live in the harness (mori: `src/external/embeddings/`) so the kernel tree stays
 * free of network and configuration access and remains replaceable.
 *
 * Everything here is OPTIONAL: pass `undefined` for the embedder and every helper
 * is a silent no-op, leaving FTS5 lexical search (the pre-P3-c behavior) — the
 * "local fallback / works without a key" guarantee, now a caller decision rather
 * than an ambient env lookup.
 */

/** Stable content hash used to skip re-embedding unchanged memory text. */
export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Cosine similarity in [-1, 1]; 0 for empty/mismatched-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export const RRF_K = 60;

/**
 * Reciprocal Rank Fusion: merge several ranked id-lists (best-first) into one
 * score map, higher = better. Scale-free — combines BM25 and cosine rankings
 * without normalizing their incompatible score ranges. `score(id) = Σ 1/(k+rank)`.
 */
export function reciprocalRankFusion(
  rankedLists: string[][],
  k: number = RRF_K,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank += 1) {
      const id = list[rank]!;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    }
  }
  return scores;
}

export interface EnsureEmbeddingsResult {
  /** Memories (re-)embedded this call. 0 when off, up-to-date, or on failure. */
  embedded: number;
}

/**
 * Best-effort: embed any valid memory whose text/model lacks a current vector,
 * and upsert it. NEVER throws (the autoPush gate pattern) — a network error or a
 * timeout degrades to a silent no-op, so a consolidation boundary is never
 * blocked or failed by embeddings. Called after consolidation (where new memories
 * appear); the per-call cost is bounded to the stale set and only paid at
 * boundaries.
 *
 * `embedder` is explicit and may be `undefined` (= embeddings off → no-op). The
 * kernel does not fall back to building one from env; any HTTP timeout is baked
 * into the harness-supplied embedder, which is where that concern belongs.
 */
export async function ensureEmbeddings(
  projectId: string,
  embedder: Embedder | undefined,
): Promise<EnsureEmbeddingsResult> {
  try {
    if (!embedder) return { embedded: 0 };

    const memories = listValidMemories(projectId).map((row) => row.memory);
    if (memories.length === 0) return { embedded: 0 };

    const existing = new Map<string, EmbeddingRow>(
      listEmbeddings(projectId, "memory").map((row) => [row.entityId, row]),
    );
    const stale = memories.filter((memory) => {
      const current = existing.get(memory.id);
      return (
        !current || current.textHash !== hashText(memory.text) || current.model !== embedder.model
      );
    });
    if (stale.length === 0) return { embedded: 0 };

    const vectors = await embedder.embed(stale.map((memory) => memory.text));
    const createdAt = nowIso();
    let embedded = 0;
    for (let i = 0; i < stale.length; i += 1) {
      const memory = stale[i]!;
      const vector = vectors[i];
      if (!vector || vector.length === 0) continue;
      upsertEmbedding(projectId, {
        entityId: memory.id,
        kind: "memory",
        model: embedder.model,
        dim: vector.length,
        vector,
        textHash: hashText(memory.text),
        createdAt,
      });
      embedded += 1;
    }
    return { embedded };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`WARN: embeddings deferred (${message})\n`);
    return { embedded: 0 };
  }
}

/**
 * Best-effort semantic index for raw transcript `segments` (v10) — the parallel
 * of `ensureEmbeddings` over the segments table, keyed by segment id under
 * kind='segment'. NEVER throws (absent/failed embedder => silent no-op; FTS still
 * covers segments). Called at the consolidation boundary after segments are
 * written; cost bounded to the stale set. Same injection rule as
 * `ensureEmbeddings`: the embedder is explicit, `undefined` means off.
 */
export async function ensureSegmentEmbeddings(
  projectId: string,
  embedder: Embedder | undefined,
): Promise<EnsureEmbeddingsResult> {
  try {
    if (!embedder) return { embedded: 0 };

    const segments = listSegments(projectId);
    if (segments.length === 0) return { embedded: 0 };

    const existing = new Map<string, EmbeddingRow>(
      listEmbeddings(projectId, "segment").map((row) => [row.entityId, row]),
    );
    const stale = segments.filter((seg) => {
      const current = existing.get(seg.id);
      return (
        !current || current.textHash !== hashText(seg.text) || current.model !== embedder.model
      );
    });
    if (stale.length === 0) return { embedded: 0 };

    const vectors = await embedder.embed(stale.map((seg) => seg.text));
    const createdAt = nowIso();
    let embedded = 0;
    for (let i = 0; i < stale.length; i += 1) {
      const seg = stale[i]!;
      const vector = vectors[i];
      if (!vector || vector.length === 0) continue;
      upsertEmbedding(projectId, {
        entityId: seg.id,
        kind: "segment",
        model: embedder.model,
        dim: vector.length,
        vector,
        textHash: hashText(seg.text),
        createdAt,
      });
      embedded += 1;
    }
    return { embedded };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`WARN: segment embeddings deferred (${message})\n`);
    return { embedded: 0 };
  }
}

import { getDb } from "../storage/db.js";
import { laneWhere } from "./projection-store.js";

/**
 * Read/write the `embeddings` table (v8) — the derived, best-effort semantic
 * index for P3-c. One row per consolidated memory text. Vectors are stored as a
 * JSON `number[]` in a TEXT column (no native vector extension); cosine
 * similarity is computed in JS at query time (embeddings-service). This table is
 * maintained out-of-band by `ensureEmbeddings`, NOT by rebuildProjectProjection.
 */

export interface StoredEmbedding {
  entityId: string;
  /** Source kind — 'memory' for the round-1 long-term layer. */
  kind: string;
  /** Model that produced the vector; a mismatch triggers re-embedding. */
  model: string;
  /** Vector dimensionality (informational; cosine guards length anyway). */
  dim: number;
  vector: number[];
  /** Hash of the embedded text; a mismatch triggers re-embedding. */
  textHash: string;
  createdAt: string;
}

export interface EmbeddingRow {
  entityId: string;
  kind: string;
  model: string;
  vector: number[];
  textHash: string;
}

function parseRow(row: {
  entity_id: string;
  kind: string;
  model: string;
  vector: string;
  text_hash: string;
}): EmbeddingRow {
  return {
    entityId: row.entity_id,
    kind: row.kind,
    model: row.model,
    vector: JSON.parse(row.vector) as number[],
    textHash: row.text_hash,
  };
}

/** Insert or replace one memory's embedding (keyed by entity_id). */
export function upsertEmbedding(projectId: string, embedding: StoredEmbedding): void {
  getDb(projectId)
    .prepare(
      `INSERT INTO embeddings
         (entity_id, kind, model, dim, vector, text_hash, created_at)
       VALUES
         (@entityId, @kind, @model, @dim, @vector, @textHash, @createdAt)
       ON CONFLICT(entity_id) DO UPDATE SET
         kind       = excluded.kind,
         model      = excluded.model,
         dim        = excluded.dim,
         vector     = excluded.vector,
         text_hash  = excluded.text_hash,
         created_at = excluded.created_at`,
    )
    .run({
      entityId: embedding.entityId,
      kind: embedding.kind,
      model: embedding.model,
      dim: embedding.dim,
      vector: JSON.stringify(embedding.vector),
      textHash: embedding.textHash,
      createdAt: embedding.createdAt,
    });
}

/**
 * Physically remove one entity's embedding row (M3-b gc). Embeddings are a
 * derived, out-of-band index NOT rebuilt by rebuildProjectProjection, so when
 * a memory's events are hard-deleted its stale vector must be pruned explicitly
 * or it lingers (and would keep scoring in semantic search). No-op if absent.
 */
export function deleteEmbedding(projectId: string, entityId: string): void {
  getDb(projectId).prepare("DELETE FROM embeddings WHERE entity_id = ?").run(entityId);
}

/**
 * All stored embeddings, optionally filtered by kind and/or model. Callers on
 * the search path (search-service.ts) pass the active embedder's model so a
 * stale vector from a since-changed `MEMORIZE_EMBEDDINGS_MODEL` never reaches
 * cosine comparison against a new-model query vector — the filter lives in the
 * SQL `WHERE`, not a JS post-filter, so a large corpus doesn't pay to read rows
 * it will immediately discard.
 *
 * `kind`/`model` gate on `!== undefined`, not truthiness: omit the argument to
 * skip the filter, pass `""` to mean "match rows stored with that literal
 * value". A truthy check would silently drop the SQL predicate for `""` and
 * return the whole table — see mori#121.
 */
export function listEmbeddings(projectId: string, kind?: string, model?: string): EmbeddingRow[] {
  const db = getDb(projectId);
  const clauses: string[] = [];
  const params: string[] = [];
  if (kind !== undefined) {
    clauses.push("kind = ?");
    params.push(kind);
  }
  if (model !== undefined) {
    clauses.push("model = ?");
    params.push(model);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT entity_id, kind, model, vector, text_hash FROM embeddings${where}`)
    .all(...params) as Array<{
    entity_id: string;
    kind: string;
    model: string;
    vector: string;
    text_hash: string;
  }>;
  return rows.map(parseRow);
}

/**
 * Cheap existence probe: does this project's corpus hold at least one vector
 * for `kind` under `model` that a consumer would actually use? Unlike
 * {@link listEmbeddings}, this never reads the `vector` column (a
 * `SELECT 1 … LIMIT 1`), so a caller that only needs to know "is there
 * anything to embed against" does not pay to load the corpus it is trying to
 * avoid touching (mori#237).
 *
 * `kind === "memory"` joins to `memories` and applies the SAME liveness
 * filter `listValidMemories` reads through (`invalid_at IS NULL` + self-lane
 * `laneWhere`, projection-store.ts:1024) — mori#257: a memory's row in
 * `embeddings` outlives invalidation (`deleteEmbedding` has no caller in this
 * repo), so without this join a project whose memories are all invalidated
 * would probe `true` forever and `buildMemoryContext` would keep paying for a
 * remote embed the consumer can never use. Both indexed columns
 * (`embeddings.entity_id`/`memories.id` PRIMARY KEY pair, `idx_embeddings_kind`)
 * back the join and `LIMIT 1` still short-circuits on the first live match, so
 * this stays a cheap existence probe, not a corpus load.
 *
 * `kind === "segment"` is NOT joined: `pruneSegments` deletes a segment's
 * `embeddings` row in the SAME transaction as the `segments` row
 * (segment-store.ts `pruneSegments`), so the retention path never produces an
 * orphaned segment embedding, and `upsertSegmentEmbeddingIfLive`
 * (embeddings-service.ts, mori#255 defect 2) closes the one write-side race
 * that could have resurrected one. There is no liveness gap to close here —
 * see the issue body for the code audit that ruled this out.
 */
export function hasEmbeddings(projectId: string, kind: string, model: string): boolean {
  const db = getDb(projectId);
  if (kind === "memory") {
    const row = db
      .prepare(
        `SELECT 1
           FROM embeddings
           JOIN memories ON memories.id = embeddings.entity_id
          WHERE embeddings.kind = ? AND embeddings.model = ?
            AND memories.invalid_at IS NULL AND ${laneWhere("self")}
          LIMIT 1`,
      )
      .get(kind, model);
    return row !== undefined;
  }
  const row = db
    .prepare("SELECT 1 FROM embeddings WHERE kind = ? AND model = ? LIMIT 1")
    .get(kind, model);
  return row !== undefined;
}

/** One embedding by entity id, or undefined. */
export function getEmbedding(projectId: string, entityId: string): EmbeddingRow | undefined {
  const row = getDb(projectId)
    .prepare("SELECT entity_id, kind, model, vector, text_hash FROM embeddings WHERE entity_id = ?")
    .get(entityId) as
    | {
        entity_id: string;
        kind: string;
        model: string;
        vector: string;
        text_hash: string;
      }
    | undefined;
  return row ? parseRow(row) : undefined;
}

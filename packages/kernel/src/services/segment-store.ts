import { getDb } from "../storage/db.js";
import { laneWhere, type ProjectionLane } from "./projection-store.js";

/**
 * Read/write the `segments` table (v10) — a DERIVED, bounded short-term
 * buffer of raw transcript content. `insertSegments` and `pruneSegments`
 * (#92) are the write/retention path that `consolidate()` will drive
 * (wiring is #94's scope, not this slice's) — `pruneSegments` deletes its
 * own matching `search_fts`/`embeddings` rows rather than relying on a
 * caller to reindex afterward (#116); `listSegments` (needed by
 * `rebuildProjectProjection` to re-populate `search_fts` under kind='segment')
 * and `listSegmentTexts` (hydrates search-service/memory-retrieval-service
 * hits with full segment text) are the read side ported earlier (#10, #62).
 *
 * `insertSegments` never accepts a `sourceProjectId` (see `NewSegmentRow`) —
 * mori has no workspace union/sync, so every write is a locally-captured
 * segment and the column is left NULL (= self). Both readers default to the
 * `self` lane (mirrors `listValidMemories`, SoT-040): a foreign segment's raw
 * transcript text must never reach the embedder or a self-context search
 * result (#72). The one caller that legitimately needs every lane's rows —
 * `rebuildProjectProjection`'s FTS reindex, which mirrors `source_project_id`
 * into `search_fts` itself — passes `"union"` explicitly.
 */

export interface SegmentRow {
  id: string;
  sessionId?: string;
  createdAt: string;
  ordinal: number;
  source?: string;
  text: string;
  /**
   * Origin store lane (M2 `(entity, writer)` projection). Undefined = self.
   * Locally-captured segments are always self; a non-self value would arrive
   * only via a workspace union (W3). Kept out of FTS folding via the mirrored
   * `search_fts.source_project_id`. See docs/SoT/040.
   */
  sourceProjectId?: string;
}

interface RawRow {
  id: string;
  session_id: string | null;
  created_at: string;
  ordinal: number | null;
  source: string | null;
  source_project_id: string | null;
  text: string;
}

function parseRow(r: RawRow): SegmentRow {
  return {
    id: r.id,
    ...(r.session_id ? { sessionId: r.session_id } : {}),
    createdAt: r.created_at,
    ordinal: r.ordinal ?? 0,
    ...(r.source ? { source: r.source } : {}),
    ...(r.source_project_id ? { sourceProjectId: r.source_project_id } : {}),
    text: r.text,
  };
}

/**
 * All segments, newest first. Used for FTS rebuild (`lane: "union"`) and
 * embedding (`ensureSegmentEmbeddings`, self-only default).
 */
export function listSegments(projectId: string, lane: ProjectionLane = "self"): SegmentRow[] {
  const rows = getDb(projectId)
    .prepare(
      `SELECT id, session_id, created_at, ordinal, source, source_project_id, text FROM segments WHERE ${laneWhere(lane)} ORDER BY created_at DESC, ordinal ASC`,
    )
    .all() as RawRow[];
  return rows.map(parseRow);
}

/** Map of segment id -> text, for hydrating search hits (text isn't in the projection). */
export function listSegmentTexts(
  projectId: string,
  lane: ProjectionLane = "self",
): Map<string, string> {
  const rows = getDb(projectId)
    .prepare(`SELECT id, text FROM segments WHERE ${laneWhere(lane)}`)
    .all() as Array<{
    id: string;
    text: string;
  }>;
  return new Map(rows.map((r) => [r.id, r.text]));
}

/** Insert-only shape: writes never carry a `sourceProjectId` (see module docstring). */
export type NewSegmentRow = Omit<SegmentRow, "sourceProjectId">;

/** Bulk-insert segments for one consolidation boundary (single transaction). */
export function insertSegments(projectId: string, rows: NewSegmentRow[]): void {
  if (rows.length === 0) return;
  const db = getDb(projectId);
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO segments (id, session_id, created_at, ordinal, source, text)
     VALUES (@id, @sessionId, @createdAt, @ordinal, @source, @text)`,
  );
  const tx = db.transaction((batch: NewSegmentRow[]) => {
    for (const s of batch) {
      stmt.run({
        id: s.id,
        sessionId: s.sessionId ?? null,
        createdAt: s.createdAt,
        ordinal: s.ordinal,
        source: s.source ?? null,
        text: s.text,
      });
    }
  });
  tx(rows);
}

export interface PruneOptions {
  /** Delete segments older than this many days. */
  maxAgeDays?: number;
  /** After age pruning, if more than this remain, drop the oldest beyond the cap. */
  maxCount?: number;
  /** Clock injection for tests; defaults to Date.now(). */
  nowMs?: number;
}

export const SEGMENT_RETENTION_DAYS = 30;
export const SEGMENT_RETENTION_MAX = 2000;

/**
 * Retention: keep segments to a rolling window so the buffer stays bounded (it
 * is NOT a permanent store — that would defeat consolidation's compression).
 * Deletes by age then by count (oldest first within a boundary, see the
 * `ordinal DESC` note below), and removes the matching kind='segment' rows
 * from BOTH derived tables so they stay consistent with `segments`:
 * `embeddings` (pairs with the pruned-vector pre-filter `hybridSearchSegments`
 * applies before its poolSize slice, #75, so a stale embedding for a pruned
 * segment never outranks a live one) and `search_fts` (so a pruned segment's
 * original text can't still surface as an FTS hit/snippet, #116 — this makes
 * the "deleted segments aren't searchable" property a guarantee of this
 * function itself, not of callers reindexing afterward). Returns deleted ids
 * for callers that want to log/report what was dropped.
 */
export function pruneSegments(projectId: string, opts: PruneOptions = {}): string[] {
  const db = getDb(projectId);
  const maxAgeDays = opts.maxAgeDays ?? SEGMENT_RETENTION_DAYS;
  const maxCount = opts.maxCount ?? SEGMENT_RETENTION_MAX;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoffIso = new Date(nowMs - maxAgeDays * 86_400_000).toISOString();

  const deleted: string[] = [];
  const aged = db.prepare("SELECT id FROM segments WHERE created_at < ?").all(cutoffIso) as Array<{
    id: string;
  }>;
  for (const r of aged) deleted.push(r.id);

  // Over-cap: oldest beyond maxCount (counting only those not already aged
  // out). `ordinal DESC` within a shared `created_at` matters, not just
  // style: every chunk of one consolidation boundary shares a single
  // `created_at` (consolidate-service.ts assigns it once per boundary), so
  // ties are the rule, not the exception. When the cap cuts through a tied
  // group, `ordinal ASC` would slice off the *higher* ordinals — the later,
  // more-recent part of that boundary's text — and keep the earlier part,
  // inverting the "drop oldest" contract and leaving a discontinuous window
  // (a boundary's opening survives, its ending doesn't, while the next
  // boundary stays intact). `ordinal DESC` keeps the highest ordinal per
  // group first, so `slice(maxCount)` drops the lowest (oldest) ordinals.
  const survivors = db
    .prepare("SELECT id FROM segments WHERE created_at >= ? ORDER BY created_at DESC, ordinal DESC")
    .all(cutoffIso) as Array<{ id: string }>;
  if (survivors.length > maxCount) {
    for (const r of survivors.slice(maxCount)) deleted.push(r.id);
  }

  if (deleted.length === 0) return [];
  const delSeg = db.prepare("DELETE FROM segments WHERE id = ?");
  const delEmb = db.prepare("DELETE FROM embeddings WHERE entity_id = ? AND kind = 'segment'");
  // Mirrors delEmb: search_fts is a standalone (non external-content) FTS5
  // table that holds its own copy of `text` (storage/db.ts v4/v12), so a
  // pruned segment's row there is a second copy of expired raw text that
  // must be deleted here too, not left for a downstream rebuild to catch.
  // Without this, `searchByKind`/`hybridSearchSegments`'s FTS branch (which
  // has no pruned-id pre-filter — that only guards the semantic branch, #75)
  // would keep returning the deleted segment's exact original text as a
  // snippet. `pruneSegments` is exported and callable on its own (not only
  // via consolidate-service.ts's prune-then-reindex sequencing), so this
  // table must stay consistent by itself rather than depending on a caller
  // always reindexing afterward.
  const delFts = db.prepare("DELETE FROM search_fts WHERE entity_id = ? AND kind = 'segment'");
  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) {
      delSeg.run(id);
      delEmb.run(id);
      delFts.run(id);
    }
  });
  tx(deleted);
  return deleted;
}

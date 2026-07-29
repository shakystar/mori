import { getDb } from "../storage/db.js";
import { laneWhere, type ProjectionLane } from "./projection-store.js";

/**
 * Read side of the `segments` table (v10) — a DERIVED, bounded short-term
 * buffer of raw transcript content. `listSegments` (needed by
 * `rebuildProjectProjection` to re-populate `search_fts` under kind='segment')
 * and `listSegmentTexts` (hydrates search-service/memory-retrieval-service
 * hits with full segment text) are ported here; the write path
 * (`insertSegments`, `pruneSegments`, consolidate()'s use of this table)
 * belongs to the consolidate-service slice (#64) and is not yet ported, so
 * this table is always empty until then.
 *
 * Both readers default to the `self` lane (mirrors `listValidMemories`,
 * SoT-040): a foreign segment's raw transcript text must never reach the
 * embedder or a self-context search result (#72). The one caller that
 * legitimately needs every lane's rows — `rebuildProjectProjection`'s FTS
 * reindex, which mirrors `source_project_id` into `search_fts` itself —
 * passes `"union"` explicitly.
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

import { getDb } from "../storage/db.js";

/**
 * Read side of the `segments` table (v10) — a DERIVED, bounded short-term
 * buffer of raw transcript content. Only the reader `rebuildProjectProjection`
 * needs (to re-populate `search_fts` under kind='segment') is ported here;
 * the write path (`insertSegments`, `pruneSegments`, consolidate()'s use of
 * this table) belongs to the services layer (#11) and is not yet ported, so
 * this table is always empty until then.
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

/** All segments, newest first. Used for FTS rebuild and embedding. */
export function listSegments(projectId: string): SegmentRow[] {
  const rows = getDb(projectId)
    .prepare(
      "SELECT id, session_id, created_at, ordinal, source, source_project_id, text FROM segments ORDER BY created_at DESC, ordinal ASC",
    )
    .all() as RawRow[];
  return rows.map(parseRow);
}

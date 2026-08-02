import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { getMemorizeRoot, getProjectDbFile } from "./path-resolver.js";
import { resolveNativeBinding } from "./native-addon.js";

/**
 * Self/union classification shared by the v15 (#120) and v16 (#150) lane
 * backfills: prescan `project.created` genesis events the same way
 * `reduceProjectState` does, so a legacy (pre-v11) NULL-provenance event
 * resolves identically here and at projection time.
 */
function scanGenesis(
  db: Database.Database,
  projectId: string | undefined,
): { isUnion: boolean; selfId: string | undefined } {
  const genesisIds = new Set<string>();
  let firstGenesisId: string | undefined;
  for (const row of db
    .prepare("SELECT payload FROM events WHERE type = 'project.created' ORDER BY seq")
    .iterate() as IterableIterator<{ payload: string }>) {
    const id = (JSON.parse(row.payload) as { id?: string }).id;
    if (id === undefined) continue;
    if (firstGenesisId === undefined) firstGenesisId = id;
    genesisIds.add(id);
  }
  return { isUnion: genesisIds.size > 1, selfId: projectId ?? firstGenesisId };
}

/** Mirrors `laneOf` (projections/projector.ts) against raw event columns. */
function laneFromEvent(
  source: string | null,
  eventProjectId: string,
  selfId: string | undefined,
  isUnion: boolean,
): string | null {
  if (source != null) return source === selfId ? null : source;
  if (!isUnion || eventProjectId === selfId) return null;
  return eventProjectId;
}

/**
 * Backfill `source_project_id` on one entity table from the LAST matching
 * creation event per entity id (seq order) — introduced by #150 to generalize
 * v15's single-table (`observations`) mechanism to tasks/handoffs/sessions/
 * memories, and adopted BY v15 itself in #154 so `observations` and the v12
 * tables share one implementation rather than two copies that drift.
 *
 * Last-wins (unconditional `Map.set`, no `has()`-guard): the projected row is
 * the product of the LAST event that touched its id, not the first.
 * `reduceProjectState` overwrites an entity's record on every such event
 * (`observations` plainly — `state.observations[observation.id] = ...` per
 * capture; `memories` likewise on repeat `memory.consolidated`), so the
 * provenance stapled onto that row has to come from the same event whose
 * `data` the rebuild would leave there. Anything else pairs one event's
 * payload with another event's lane, which is a state no rebuild can produce
 * — and since the next write runs `rebuildProjectProjection`, the lane would
 * then flip silently. v15 originally took the first event per id and said so
 * in a comment; that comment asserted an intent the projector does not share,
 * and #154 reversed it (owner review of PR #153, weakness ①). Event ids are
 * unique but payload entity ids are not constrained by the schema, so
 * "captures are not repeated per id" is a convention, not an invariant.
 *
 * Cursors (`db.prepare(...).iterate()`), not `.all()`, on both the event scan
 * and the table scan: materializing a whole table + a whole event type at
 * once has no upper bound (both are append-only), and this runs inside
 * `runMigrations`' `BEGIN IMMEDIATE`, where the spike is paid while holding
 * the write lock — long enough, on an old store, to blow through another
 * opener's `busy_timeout = 5000` (owner review of PR #153, weakness ②).
 *
 * `laneInData` says whether this table's `data` blob ALSO carries the lane —
 * it is NOT uniform across the five tables, and writing it where the rebuild
 * does not would break the identity property just as surely as omitting it
 * where the rebuild does. `memories` (like v15's `observations`) is id-keyed
 * with the lane on the record itself (`MemoryRecord.sourceProjectId`,
 * projections/projector.ts), so its `data` carries it. `tasks`/`handoffs`/
 * `sessions` are LANE-KEYED instead — the reducer keeps the lane in the
 * state-map key (`laneKey`) and stores the bare domain entity, so
 * `JSON.stringify(task)` has no `sourceProjectId` and the column is the only
 * sink (see the `insert*` loops in services/projection-store.ts).
 */
function backfillEntityTableLane(
  db: Database.Database,
  table: string,
  eventType: string,
  extractId: (payload: unknown) => string | undefined,
  laneInData: boolean,
  selfId: string | undefined,
  isUnion: boolean,
): void {
  // LIMIT 1 instead of a count/materialize: existence is all this check needs.
  if (!db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) return;

  // The one structure that scales with the store: an id -> lane entry per
  // DISTINCT entity, two short strings each. Deliberate — the cursor above is
  // what keeps event PAYLOADS (unbounded blobs, and the actual source of the
  // spike weakness ② reports) from ever being resident together, and this map
  // is what lets the table pass below stay a single ordered scan instead of a
  // per-row event lookup. Collapsing it further would mean joining events to
  // the table in SQL, which cannot express `laneFromEvent`'s genesis-dependent
  // branch without duplicating `scanGenesis` into the query.
  const laneById = new Map<string, string | null>();
  for (const row of db
    .prepare(
      `SELECT source_project_id, project_id, payload FROM events WHERE type = ? ORDER BY seq`,
    )
    .iterate(eventType) as IterableIterator<{
    source_project_id: string | null;
    project_id: string;
    payload: string;
  }>) {
    const id = extractId(JSON.parse(row.payload) as unknown);
    if (id === undefined) continue;
    laneById.set(id, laneFromEvent(row.source_project_id, row.project_id, selfId, isUnion));
  }

  // Whichever sinks the projection writer keeps in step for THIS table: the
  // column always (it is what `laneWhere` filters on), plus
  // `data.sourceProjectId` only where the rebuilt record carries it too — see
  // `laneInData` above.
  const updateColumnOnly = db.prepare(`UPDATE ${table} SET source_project_id = ? WHERE id = ?`);
  const updateWithData = db.prepare(
    `UPDATE ${table} SET source_project_id = ?, data = ? WHERE id = ?`,
  );
  // Keyset-paginated `.all()` batches, NOT a live `.iterate()` cursor: better-
  // sqlite3 forbids running a second statement (the UPDATE below) while a
  // cursor from a `.prepare().iterate()` on this same connection is paused
  // mid-stream ("This database connection is busy executing a query"). Paging
  // by rowid keeps each batch's memory bounded without hitting that limit.
  //
  // 500 rows: large enough that the per-batch `SELECT` overhead stays noise
  // next to the per-row `UPDATE`s it feeds (so the write lock is not held any
  // longer than the unbatched version held it), small enough that the resident
  // set is a few hundred `data` blobs rather than the whole table. The exact
  // number is not load-bearing — only that it is a constant, which is what
  // puts the ceiling on concurrent residency.
  //
  // Every batch runs inside `runMigrations`' single `BEGIN IMMEDIATE`, not one
  // transaction per batch: the `user_version` bump lives in that same
  // transaction, so committing per batch would mean restructuring the
  // migration runner (out of #154's scope) to leave a store at a version whose
  // migration only half-ran. It is also unnecessary — the bound this wants is
  // on MEMORY, and batching alone gives that. An interrupted run therefore
  // rolls back whole, and even a hypothetical partial one would be harmless to
  // re-run: the lane is a pure function of `events` rows, which are immutable
  // and append-only, so recomputing it yields the same value it wrote before
  // (`data.sourceProjectId` is overwritten, not accumulated).
  const BATCH_SIZE = 500;
  const selectBatch = db.prepare(
    `SELECT rowid AS rowid_, id${laneInData ? ", data" : ""} FROM ${table} ` +
      `WHERE rowid > ? ORDER BY rowid LIMIT ?`,
  );
  let afterRowid = 0;
  for (;;) {
    const batch = selectBatch.all(afterRowid, BATCH_SIZE) as Array<{
      rowid_: number;
      id: string;
      data?: string;
    }>;
    if (batch.length === 0) break;
    for (const row of batch) {
      // No matching creating event (should not occur), or the event resolves
      // to self: keep NULL, the pre-existing default — no guessing (#120).
      // Skipping rather than writing NULL is also what keeps a single-writer
      // store byte-identical: no UPDATE, so `data` is not re-serialized.
      const lane = laneById.get(row.id);
      if (lane == null) continue;
      if (laneInData) {
        const data = JSON.parse(row.data!) as Record<string, unknown>;
        data.sourceProjectId = lane;
        updateWithData.run(lane, JSON.stringify(data), row.id);
      } else {
        updateColumnOnly.run(lane, row.id);
      }
    }
    afterRowid = batch[batch.length - 1]!.rowid_;
    if (batch.length < BATCH_SIZE) break;
  }
}

/**
 * Mirror the now-corrected entity-table lanes onto `search_fts` (#150) — v12
 * gave `search_fts` its own copy of `source_project_id` (a virtual table
 * column, populated at index time, not a live join), so it needs the same
 * correction the entity tables just got. Set-based SQL, no JS
 * materialization needed: `entity_id` is already the join key on both sides.
 * `SearchKind` (services/projection-store.ts) excludes `session` (sessions
 * are never indexed) and has no lane concept for `decision`/`checkpoint`/
 * `topic` (their source tables never got a v12 column — out of #150's
 * scope), so only these four kinds apply.
 */
function backfillSearchFtsLane(db: Database.Database): void {
  const kindTables: ReadonlyArray<readonly [string, string]> = [
    ["task", "tasks"],
    ["handoff", "handoffs"],
    ["memory", "memories"],
    ["segment", "segments"],
  ];
  for (const [kind, table] of kindTables) {
    db.prepare(
      `UPDATE search_fts SET source_project_id = (
         SELECT source_project_id FROM ${table} WHERE ${table}.id = search_fts.entity_id
       ) WHERE kind = ?`,
    ).run(kind);
  }
}

/**
 * Ordered DDL migrations applied via `PRAGMA user_version`. The user_version
 * tracks table DDL only; it is ORTHOGONAL to per-row `event.schemaVersion`
 * (which versions payload shape, not table structure). Append future
 * migrations to this array — never reorder or mutate existing entries.
 */
const MIGRATIONS: ReadonlyArray<(db: Database.Database, projectId?: string) => void> = [
  // v1 — events table + indexes (Phase 0: created but not yet written to).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq            INTEGER PRIMARY KEY,
        id             TEXT NOT NULL UNIQUE,
        schema_version INTEGER NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        type           TEXT NOT NULL,
        project_id     TEXT NOT NULL,
        scope_type     TEXT NOT NULL,
        scope_id       TEXT NOT NULL,
        actor          TEXT NOT NULL,
        payload        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_type  ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_scope ON events(scope_type, scope_id);
    `);
  },
  // v2 — key/value meta table (Phase 1: holds the ndjson migration marker).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  },
  // v3 — projection tables (Phase 2). Each row stores the full entity in a
  // `data` JSON column; extra columns exist only where a reader queries or
  // sorts by them. `project` and `memory_index` are per-db singletons (one
  // row, id = projectId). reduceProjectState remains the single reduction
  // authority — these tables are a persistence sink, not a parallel reducer.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id   TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_index (
        id   TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workstreams (
        id     TEXT PRIMARY KEY,
        status TEXT,
        data   TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id            TEXT PRIMARY KEY,
        status        TEXT,
        workstream_id TEXT,
        created_at    TEXT,
        updated_at    TEXT,
        data          TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS handoffs (
        id   TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        id   TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id     TEXT PRIMARY KEY,
        status TEXT,
        data   TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rules (
        id     TEXT PRIMARY KEY,
        source TEXT,
        data   TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conflicts (
        id     TEXT PRIMARY KEY,
        status TEXT,
        data   TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id     TEXT PRIMARY KEY,
        status TEXT,
        data   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_conflicts_status ON conflicts(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_status  ON sessions(status);
    `);
  },
  // v4 — FTS5 full-text search index (Phase 3). Standalone (NOT
  // external-content) virtual table: `text` is the only indexed column;
  // `entity_id` and `kind` ride along UNINDEXED for retrieval/display.
  // `kind` ∈ {task, handoff, decision, checkpoint, topic}. Populated as a
  // replace-all sink inside rebuildProjectProjection's transaction — never
  // written through a second path. If the bundled SQLite lacks FTS5 this
  // CREATE throws and the migration fails loudly (no silent fallback).
  (db) => {
    db.exec(`
      CREATE VIRTUAL TABLE search_fts USING fts5(
        entity_id UNINDEXED,
        kind UNINDEXED,
        text,
        tokenize='unicode61'
      );
    `);
  },
  // v5 — correct events.schema_version column type from INTEGER to TEXT. The
  // stored value is the semver STRING `CURRENT_SCHEMA_VERSION` (e.g. '0.1.0');
  // INTEGER affinity stored it as text losslessly today, but a future numeric
  // comparison/sort would mis-order it. SQLite can't ALTER a column type, so
  // rebuild the table: copy every row in seq order into an identically-shaped
  // table with `schema_version TEXT`, swap, then recreate the two indexes.
  (db) => {
    db.exec(`
      CREATE TABLE events_new (
        seq            INTEGER PRIMARY KEY,
        id             TEXT NOT NULL UNIQUE,
        schema_version TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        type           TEXT NOT NULL,
        project_id     TEXT NOT NULL,
        scope_type     TEXT NOT NULL,
        scope_id       TEXT NOT NULL,
        actor          TEXT NOT NULL,
        payload        TEXT NOT NULL
      );
      INSERT INTO events_new
        (seq, id, schema_version, created_at, updated_at, type,
         project_id, scope_type, scope_id, actor, payload)
      SELECT
        seq, id, schema_version, created_at, updated_at, type,
        project_id, scope_type, scope_id, actor, payload
      FROM events;
      DROP TABLE events;
      ALTER TABLE events_new RENAME TO events;
      CREATE INDEX IF NOT EXISTS idx_events_type  ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_scope ON events(scope_type, scope_id);
    `);
  },
  // v6 — CLS two-layer memory projection tables (Phase 1 spec §2). Both are
  // replace-all sinks of rebuildProjectProjection, derived from
  // `observation.captured` / `memory.consolidated` / `memory.superseded`
  // events — always reconstructable by replay. The mutable columns on
  // `memories` (`invalid_at`, `superseded_by`, `last_accessed_at`) live at
  // the DERIVED projection level only; the events table stays append-only.
  // `last_accessed_at` (retrieval reinforcement) is intentionally
  // best-effort: carried over across routine rebuilds, reset by a true
  // from-scratch replay (decision ⑤, 2026-06-08).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id         TEXT PRIMARY KEY,
        session_id TEXT,
        signal     TEXT,
        created_at TEXT,
        data       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at);
      CREATE TABLE IF NOT EXISTS memories (
        id               TEXT PRIMARY KEY,
        kind             TEXT,
        salience         INTEGER,
        created_at       TEXT,
        invalid_at       TEXT,
        superseded_by    TEXT,
        last_accessed_at TEXT,
        data             TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
    `);
  },
  // v7 — cross-machine dedup loser marker (P3-a auto-convergence). Additive
  // column on the DERIVED memories table; events stay append-only. A duplicate
  // memory (same sourceObservationIds distilled concurrently on two replicas)
  // is marked with the winning memory's id here; the replace-all rebuild
  // backfills it deterministically. Separate ALTER (not folded into the v6
  // CREATE) so DBs already at v6 get the column on upgrade.
  (db) => {
    db.exec("ALTER TABLE memories ADD COLUMN deduped_by TEXT;");
  },
  // v8 — semantic-search embeddings (P3-c). A DERIVED, best-effort auxiliary
  // index keyed by the memory id: one row per consolidated memory text, holding
  // its embedding vector (JSON number[]). UNLIKE the projection tables this is
  // NOT rebuilt by rebuildProjectProjection — embeddings need an async network
  // call, so they are filled out-of-band at boundaries (ensureEmbeddings,
  // never-throw) and survive replace-all rebuilds. `text_hash`+`model` let a
  // rebuild skip re-embedding unchanged text. Absent embeddings simply mean a
  // memory does not participate in semantic ranking (FTS still covers it), so a
  // project with no embeddings endpoint configured behaves exactly as before.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        entity_id  TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        model      TEXT NOT NULL,
        dim        INTEGER NOT NULL,
        vector     TEXT NOT NULL,
        text_hash  TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_kind ON embeddings(kind);
    `);
  },
  // v9 — #62 behavioral lifecycle telemetry: how often a memory was actually
  // injected into an agent context (startup AND mid-session live share).
  // DERIVED-level, observe-only counter: like `last_accessed_at` it is
  // best-effort — carried over across routine rebuilds, reset by a true
  // from-scratch replay — and read by NO ranking/injection consumer; only
  // the `consolidate --report` evidence dump aggregates it.
  (db) => {
    db.exec("ALTER TABLE memories ADD COLUMN injection_count INTEGER NOT NULL DEFAULT 0;");
  },
  // v10 — raw transcript segments: a DERIVED, bounded short-term detail buffer
  // that makes the original conversation content retrievable ALONGSIDE the
  // (lossy, salience-gated) consolidated memories. Like `embeddings` (v8) this is
  // NOT rebuilt by the projector — it is filled out-of-band at the consolidation
  // boundary from the same transcript slice, indexed into search_fts/embeddings
  // under kind='segment', and pruned to a rolling window. A from-scratch replay
  // loses segments (re-accumulated on the next consolidation), same grade as
  // embeddings. Empty table => every retrieval surface is byte-identical to
  // before, so this is purely augmentative.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS segments (
        id         TEXT PRIMARY KEY,
        session_id TEXT,
        created_at TEXT NOT NULL,
        ordinal    INTEGER,
        source     TEXT,
        text       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_segments_created ON segments(created_at);
    `);
  },
  // v11 — per-event provenance (3.0.0 Phase 0). Two NULLABLE additive columns on
  // the append-only events table: `writer` = originating actor identity,
  // `source_project_id` = originating store id. Existing rows read back NULL.
  // Captured on append and preserved across sync, but UNCONSUMED for now (no
  // projection/reader reads them) — the foundation for later writer group-by,
  // workspace union, and origin-scoped recovery. Separate ALTER (not folded into
  // the v1 CREATE) so DBs already past v1 get the columns on upgrade; nullable +
  // no default makes it an O(1) metadata-only change even on large stores.
  (db) => {
    db.exec(`
      ALTER TABLE events ADD COLUMN writer TEXT;
      ALTER TABLE events ADD COLUMN source_project_id TEXT;
    `);
  },
  // v12 — projection provenance lane (3.0.0 M2, `(entity, writer)` projection).
  // A NULLABLE `source_project_id` on each projection table that must not fold
  // a foreign writer's row into local truth (SoT-040). NULL = self (this
  // store); a non-NULL value is the origin store of an event carried in by a
  // workspace union. The entity tables take a plain additive ALTER (O(1)).
  // search_fts is a virtual table whose columns can't be ALTERed, so it is
  // rebuilt with the extra UNINDEXED column, copying every existing row with a
  // NULL lane — no empty-index window (the hot telemetry rebuild path uses
  // reindexSearch:false, so a lazy repopulate is NOT guaranteed; carrying rows
  // across keeps search intact on upgrade). Consumed by the single
  // private-vs-union selector; single-writer stores are byte-identical because
  // every local row is NULL-lane.
  //
  // "existing rows read back NULL = self" (#150 verified this, do not copy the
  // sentence elsewhere without re-deriving it — v14 copied it unverified onto a
  // table that DID already hold foreign rows and that became #120): this is
  // provably true FOR v12, for two independent reasons. (1) Structural: this
  // MIGRATIONS array is applied in full, in order, inside one transaction on
  // every `open()` (see `runMigrations`) — so no build of this codebase has
  // ever been able to append a foreign-lane event without first running this
  // exact ALTER on that same store. A foreign row can only exist once code
  // that understands multiple project identities is deployed, and that code
  // necessarily ships with this migration already a permanent, earlier entry
  // in the array. (2) Historical (upstream shakystar/memorize, whose ladder
  // this table was ported from verbatim, 4bd9e37): the reducer carried a hard
  // divergence guard (#30, memorize 13fffa4) that THREW on more than one
  // distinct `project.created` genesis, and the ONLY commit that relaxed it is
  // the one that introduced whole-DB workspace union sync (memorize cde51f0,
  // "3.0.0 M4") — which is a strict DESCENDANT of the commit that added this
  // very migration (memorize 5458663, "3.0.0 M2"). So on the whole interval
  // where a store could be at v12, a foreign genesis still threw. mori's own
  // port never brought the union sync mechanism over at all — there is no
  // `insertExternalEvents`/`pullProject` here, and `appendEvent` defaults
  // `sourceProjectId` to the store's own `projectId`
  // (`storage/event-store.ts`) — so today reason (1) alone already holds: no
  // code path in this repo can produce a foreign-lane row in the first place.
  // #150 backfills the five tables + search_fts anyway (reusing #120's v15
  // mechanism) as defense-in-depth against a future port of that mechanism,
  // not because any real store needs repair.
  (db) => {
    db.exec(`
      ALTER TABLE tasks    ADD COLUMN source_project_id TEXT;
      ALTER TABLE handoffs ADD COLUMN source_project_id TEXT;
      ALTER TABLE sessions ADD COLUMN source_project_id TEXT;
      ALTER TABLE memories ADD COLUMN source_project_id TEXT;
      ALTER TABLE segments ADD COLUMN source_project_id TEXT;

      CREATE VIRTUAL TABLE search_fts_new USING fts5(
        entity_id UNINDEXED,
        kind UNINDEXED,
        text,
        source_project_id UNINDEXED,
        tokenize='unicode61'
      );
      INSERT INTO search_fts_new (entity_id, kind, text, source_project_id)
        SELECT entity_id, kind, text, NULL FROM search_fts;
      DROP TABLE search_fts;
      ALTER TABLE search_fts_new RENAME TO search_fts;
    `);
  },
  // v13 — task_requests projection table (3.0.0 slice 1, SoT-041 cross-project
  // delegation). A replace-all sink for `state.taskRequests`, same grade as the
  // v3 entity tables: `data` holds the full entity JSON; the extra columns exist
  // only where a reader filters or sorts (`target_project_id` = inbound
  // addressing, `source_project_id` = provenance lane with NULL = self,
  // `created_at` = list order). A NEW entry — NOT folded into the v3 body —
  // because runMigrations replays only from the store's current user_version,
  // so DDL added to an already-shipped migration never reaches existing stores.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_requests (
        id                TEXT PRIMARY KEY,
        status            TEXT,
        target_project_id TEXT,
        source_project_id TEXT,
        created_at        TEXT,
        data              TEXT NOT NULL
      );
    `);
  },
  // v14 — #74 union-lane hardening: `observations` was left out of the v12
  // provenance ALTER (only tasks/handoffs/sessions/memories/segments got the
  // column), so every foreign (union-lane) observation.captured event
  // projected with a NULL lane — indistinguishable from self. Additive column.
  //
  // CAUTION (#120): this migration ADDS the column but does NOT populate it,
  // and "existing rows read back NULL" is NOT a safe default here — do not
  // copy this shape. v12's tables had never held a foreign row when their
  // column landed, so NULL = self was a true statement about them. This table
  // is the opposite: foreign observations were ALREADY projected into it (that
  // is the very defect #74 fixed for NEW events), so leaving them NULL writes
  // a WRONG lane, not an unknown one — a foreign observation reads back as
  // self in the short-term tail (SoT-040). The true lane was always available
  // in `events.source_project_id` (v11); v15 below moves it across. The fix
  // had to be a NEW migration entry rather than a body edit here, because
  // `runMigrations` replays only from a store's current user_version, so an
  // edit to this body would never reach the exact stores that are damaged
  // (the ones that already ran v14). Same trap the v13 comment records.
  (db) => {
    db.exec("ALTER TABLE observations ADD COLUMN source_project_id TEXT;");
  },
  // v15 — #120: backfill the lane v14 left NULL. Replays the SAME self/foreign
  // decision `laneOf` (projections/projector.ts) makes at projection time, but
  // synchronously and against this store's own event log — the async
  // `rebuildProjectProjection` lives in `services/`, above this layer, so
  // calling it from here would be a layer inversion + circular import. SQL
  // backfill (option A of #120) instead: `events` has carried
  // `source_project_id` since v11, so no value is inferred or guessed — every
  // lane written below is read off the `observation.captured` event that
  // produced the row.
  //
  // Why this cannot wait for the existing self-heal: `rebuildProjectProjection`
  // runs on WRITE paths, so a read-only session (session-start context
  // injection is the canonical one) reads the wrong lane forever, no matter
  // how many times it runs.
  //
  // Scope: `observations` only. v12's five tables (tasks/handoffs/sessions/
  // memories/segments) and `search_fts` are v16 (#150), which generalized this
  // migration's mechanism into `backfillEntityTableLane` and, per owner review
  // of PR #153, fixed two weaknesses in it. #154 pulls that corrected helper
  // back down here so `observations` runs the same code path rather than a
  // second copy — a copy that had already drifted, which is the shape of
  // defect that produced #120 in the first place:
  //
  //  ① this body took the FIRST `observation.captured` event per id and a
  //     comment declared that intent ("so a later re-projection cannot flip
  //     the lane"). `reduceProjectState` does the opposite — it overwrites the
  //     record on every capture — so on an id with more than one capture event
  //     the backfill stapled the first event's lane onto the last event's
  //     `data`, a pairing no rebuild produces. See the helper's docstring.
  //  ② this body read the whole table and the whole `observation.captured`
  //     history through `.all()`, both unbounded, inside `runMigrations`'
  //     write lock. The helper bounds concurrent residency instead.
  //
  // Stores that ALREADY ran the old v15 are deliberately NOT re-backfilled by
  // a later migration (#154 judgement): a wrong lane here needs two capture
  // events sharing one payload id AND disagreeing on lane, and the second
  // requires a foreign-lane event, which mori has no path to write — the same
  // argument v16 records for why it is a provable no-op on every store that
  // exists today. A repair migration built on this helper would also only be
  // half of one: `if (lane == null) continue` cannot walk a wrongly-written
  // non-NULL lane back to NULL, and teaching it to would cost the
  // byte-identity property below. If workspace union is ever ported, that
  // repair becomes real work and has to handle the reset-to-NULL direction.
  //
  // Single-writer stores are untouched: every row resolves to the self lane,
  // and self rows are skipped without an UPDATE, so both the column and the
  // `data` JSON stay byte-identical.
  (db, projectId) => {
    const { isUnion, selfId } = scanGenesis(db, projectId);
    // `laneInData` is true: `insertObservation` (services/projection-store.ts)
    // derives the column FROM the record, and the record itself carries
    // `sourceProjectId`, so a rebuild leaves the lane in both sinks.
    backfillEntityTableLane(
      db,
      "observations",
      "observation.captured",
      (payload) => (payload as { id?: string }).id,
      true,
      selfId,
      isUnion,
    );
  },
  // v16 — #150: generalizes v15's backfill from `observations` alone to the
  // five v12 tables (tasks/handoffs/sessions/memories) + `search_fts`, reusing
  // the SAME mechanism (SQL backfill against this store's own event log; no
  // async `rebuildProjectProjection` call from this layer — the same layering
  // constraint v15 documents), corrected per owner review of PR #153: see
  // `backfillEntityTableLane` for last-wins and cursored iteration. v15 ran
  // its own first-wins/`.all()` copy of that mechanism until #154 pointed it
  // at this same helper.
  //
  // Judgement (#150 body, gate ①) recorded here because it is the reason this
  // migration exists at all: verified (see the corrected v12 comment above,
  // and the PR description) that no real store can currently hold a
  // foreign-lane row in any of these tables — mori has never carried the
  // union-sync mechanism that would write one (no `insertExternalEvents`;
  // `storage/event-store.ts` stamps every event with this store's own id),
  // and upstream (shakystar/memorize) that mechanism landed strictly after
  // v12. This migration is therefore a provable no-op on every store that
  // exists today; it is written anyway as defense-in-depth against a future
  // port of workspace union, at which point a store that upgraded through v12
  // before that port shipped would otherwise carry stale NULL lanes exactly
  // like #120/#74 did for `observations`.
  //
  // `segments` is deliberately NOT backfilled here: unlike the other four
  // tables, it is not part of `reduceProjectState` — no `segment.*` domain
  // event backs it. It is a DERIVED short-term buffer that `insertSegments`
  // writes directly (services/segment-store.ts), and that insert path never
  // accepts a non-self lane, so there is no event to read a lane off and
  // nothing on the row that could be wrong. Its v12 column stays exactly as
  // the v12 ALTER left it — search_fts still mirrors it (below), so a future
  // fix to segment provenance only needs to touch segment-store.ts, not add
  // another migration here.
  (db, projectId) => {
    const { isUnion, selfId } = scanGenesis(db, projectId);
    const idOf = (payload: unknown): string | undefined => (payload as { id?: string }).id;

    // `laneInData` (4th arg) is true only for `memories` — see the docstring
    // on backfillEntityTableLane: the other three are lane-KEYED, their `data`
    // blob is the bare domain entity and a rebuild never puts a lane in it.
    backfillEntityTableLane(db, "tasks", "task.created", idOf, false, selfId, isUnion);
    backfillEntityTableLane(db, "handoffs", "handoff.created", idOf, false, selfId, isUnion);
    backfillEntityTableLane(db, "sessions", "session.started", idOf, false, selfId, isUnion);
    backfillEntityTableLane(db, "memories", "memory.consolidated", idOf, true, selfId, isUnion);

    backfillSearchFtsLane(db);
  },
];

function runMigrations(db: Database.Database, projectId?: string): void {
  // Acquire a write lock up front (BEGIN IMMEDIATE) and re-read user_version
  // INSIDE it. When two fresh processes open the same new DB at once, the
  // first runs the migrations and bumps user_version; the second blocks on
  // busy_timeout, then — now inside the lock — re-reads the bumped version and
  // runs nothing. Without the immediate lock both processes read version 0 up
  // front and the second re-runs the v4 `CREATE VIRTUAL TABLE search_fts`
  // (which lacks IF NOT EXISTS), throwing "table search_fts already exists".
  const runAll = db.transaction(() => {
    const current = db.pragma("user_version", { simple: true }) as number;
    for (let version = current; version < MIGRATIONS.length; version++) {
      const migrate = MIGRATIONS[version]!;
      migrate(db, projectId);
      // user_version is the count of applied migrations.
      db.pragma(`user_version = ${version + 1}`);
    }
  });
  runAll.immediate();
}

/**
 * Switch to WAL, retrying on SQLITE_BUSY. `PRAGMA journal_mode = WAL` takes a
 * brief exclusive lock and — unlike ordinary statements — does NOT honor
 * `busy_timeout`: it returns "database is locked" immediately if another
 * connection holds any lock. On a fresh DB opened by several processes at once
 * that is a real (if rare) collision, so we retry with a short backoff. The
 * busy window is the WAL switch + first migration of one process, well under
 * the total budget here.
 */
function enableWalWithRetry(db: Database.Database): void {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      db.pragma("journal_mode = WAL");
      return;
    } catch (error) {
      const busy = error instanceof Error && /database is locked|SQLITE_BUSY/.test(error.message);
      if (!busy || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

/**
 * fs/SQLite failures that all mean the same thing: the memorize data tree
 * can't be written from this process. The dominant real-world cause is a
 * sandbox — notably Codex's default `workspace-write`, whose writable roots
 * don't include `~/.memorize`. better-sqlite3 surfaces that as a bare
 * `unable to open database file`, which leaves the user nothing to act on. (#116)
 */
export function isDataDirUnwritable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EACCES" ||
    code === "EROFS" ||
    code === "EPERM" ||
    code === "SQLITE_CANTOPEN" ||
    /unable to open database file/i.test(error.message)
  );
}

/**
 * Replace the opaque open failure with a message that names the data dir and
 * the exact Codex sandbox fix, while preserving the original error as `cause`.
 */
export function unwritableDataDirError(dbFile: string, cause: Error): Error {
  const root = getMemorizeRoot();
  return new Error(
    `Cannot open the memorize database at ${dbFile} (${cause.message}). ` +
      `The memorize data directory ${root} is not writable from here.\n` +
      `If you are inside a Codex workspace-write sandbox, add "${root}" to ` +
      `sandbox_workspace_write.writable_roots in ~/.codex/config.toml, then ` +
      `restart the codex session.`,
    { cause },
  );
}

function open(dbFile: string, projectId?: string): Database.Database {
  try {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const nativeBinding = resolveNativeBinding();
    const db = nativeBinding ? new Database(dbFile, { nativeBinding }) : new Database(dbFile);
    // Set busy_timeout first so ordinary statements + the IMMEDIATE migration
    // lock wait rather than error; the WAL switch needs its own retry (above).
    db.pragma("busy_timeout = 5000");
    enableWalWithRetry(db);
    runMigrations(db, projectId);
    return db;
  } catch (error) {
    if (isDataDirUnwritable(error)) {
      throw unwritableDataDirError(dbFile, error as Error);
    }
    throw error;
  }
}

const connections = new Map<string, Database.Database>();

/** Lazily open and cache one connection per projectId for this process. */
export function getDb(projectId: string): Database.Database {
  const cached = connections.get(projectId);
  if (cached) return cached;
  const db = open(getProjectDbFile(projectId), projectId);
  connections.set(projectId, db);
  return db;
}

/** Close all cached connections (WAL auto-checkpoints on close). */
export function closeAll(): void {
  for (const db of connections.values()) {
    db.close();
  }
  connections.clear();
}

/**
 * Open an arbitrary db path (uncached) with the same pragmas + migrations.
 * Intended for tests; the per-project `getDb` API is the main surface.
 *
 * `projectId` is this store's own identity, threaded into the migrations that
 * need to tell self from foreign (the v15 observation-lane backfill, #120) —
 * the same authoritative value `rebuildProjectProjection` passes the reducer.
 * Omit it for fixtures where that identity does not matter; the backfill then
 * falls back to the first `project.created` genesis, as the reducer does.
 */
export function openDbAt(dbFile: string, projectId?: string): Database.Database {
  return open(dbFile, projectId);
}

process.once("exit", closeAll);

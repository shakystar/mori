import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION } from "../../src/domain/common.js";
import {
  listRecentObservations,
  rebuildProjectProjection,
} from "../../src/services/projection-store.js";
import { closeAll, getDb } from "../../src/storage/db.js";
import { getProjectDbFile } from "../../src/storage/path-resolver.js";

// #120 — v14 (`ALTER TABLE observations ADD COLUMN source_project_id`) added
// the lane column but never populated it, so a store that had already
// projected foreign (union-lane) observations read them back as NULL = self
// after upgrading. `rebuildProjectProjection` would repair that, but it only
// runs on WRITE paths, so a READ-ONLY session (session-start context
// injection) never self-heals — that is the damage this suite pins down.
//
// Every test below upgrades a hand-built pre-v15 store and then reads
// WITHOUT EVER WRITING. A single write anywhere would trigger the existing
// rebuild and mask the regression, so the absence of writes is the point.

const ts = "2026-01-01T00:00:00.000Z";

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-obs-backfill-"));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

/** v11-shape events table — the columns the backfill reads (`writer` + `source_project_id`) are present. */
function createEventsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE events (
      seq               INTEGER PRIMARY KEY,
      id                TEXT NOT NULL UNIQUE,
      schema_version    TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      type              TEXT NOT NULL,
      project_id        TEXT NOT NULL,
      scope_type        TEXT NOT NULL,
      scope_id          TEXT NOT NULL,
      actor             TEXT NOT NULL,
      writer            TEXT,
      source_project_id TEXT,
      payload           TEXT NOT NULL
    );
  `);
}

/**
 * `observations` as of the given schema version: pre-v14 has no lane column,
 * v14 has the column but (that being the whole defect) nothing in it.
 */
function createObservationsTable(db: Database.Database, withLaneColumn: boolean): void {
  db.exec(`
    CREATE TABLE observations (
      id         TEXT PRIMARY KEY,
      session_id TEXT,
      signal     TEXT,
      created_at TEXT,
      data       TEXT NOT NULL
      ${withLaneColumn ? ", source_project_id TEXT" : ""}
    );
  `);
}

/**
 * The v12 tables #150's v16 migration also touches, empty. Every fixture in
 * this suite pins a version >= 13 (v12 already applied/skipped), so these
 * must already carry the v12 `source_project_id` column — otherwise v16
 * (which unconditionally reads/writes it, including on `search_fts`) fails
 * with "no such table"/"no such column" even though this suite is only
 * exercising the `observations`-specific v14/v15 path.
 */
function createV12ProjectionTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, status TEXT, workstream_id TEXT,
      created_at TEXT, updated_at TEXT, source_project_id TEXT, data TEXT NOT NULL
    );
    CREATE TABLE handoffs (id TEXT PRIMARY KEY, source_project_id TEXT, data TEXT NOT NULL);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, status TEXT, source_project_id TEXT, data TEXT NOT NULL
    );
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, kind TEXT, salience INTEGER, created_at TEXT,
      invalid_at TEXT, superseded_by TEXT, last_accessed_at TEXT,
      deduped_by TEXT, injection_count INTEGER NOT NULL DEFAULT 0,
      source_project_id TEXT, data TEXT NOT NULL
    );
    CREATE TABLE segments (
      id TEXT PRIMARY KEY, session_id TEXT, created_at TEXT NOT NULL,
      ordinal INTEGER, source TEXT, source_project_id TEXT, text TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE search_fts USING fts5(
      entity_id UNINDEXED, kind UNINDEXED, text, source_project_id UNINDEXED,
      tokenize='unicode61'
    );
  `);
}

function insertEvent(
  db: Database.Database,
  row: {
    id: string;
    type: string;
    projectId: string;
    scopeId: string;
    sourceProjectId: string | null;
    payload: unknown;
  },
): void {
  db.prepare(
    `INSERT INTO events
       (id, schema_version, created_at, updated_at, type,
        project_id, scope_type, scope_id, actor, writer, source_project_id, payload)
     VALUES (?, ?, ?, ?, ?, ?, 'project', ?, 'test', 'test', ?, ?)`,
  ).run(
    row.id,
    CURRENT_SCHEMA_VERSION,
    ts,
    ts,
    row.type,
    row.projectId,
    row.scopeId,
    row.sourceProjectId,
    JSON.stringify(row.payload),
  );
}

function observationPayload(id: string, projectId: string, sessionId: string) {
  return {
    id,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    projectId,
    sessionId,
    signal: "write-tool",
    summary: `observation ${id}`,
  };
}

/** Project the observation the way a pre-v15 store did: no lane recorded anywhere. */
function insertObservationRow(
  db: Database.Database,
  observation: ReturnType<typeof observationPayload>,
): void {
  db.prepare(
    `INSERT INTO observations (id, session_id, signal, created_at, data)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    observation.id,
    observation.sessionId,
    observation.signal,
    observation.createdAt,
    JSON.stringify(observation),
  );
}

function insertGenesis(db: Database.Database, projectId: string, title: string): void {
  insertEvent(db, {
    id: `evt_genesis_${projectId}`,
    type: "project.created",
    projectId,
    scopeId: projectId,
    sourceProjectId: projectId,
    payload: { id: projectId, title },
  });
}

/**
 * A store carrying one self observation and one foreign observation that
 * arrived through a workspace union, pinned at `userVersion`. The event log
 * records the true origin of both (event-level provenance since v11); the
 * projection has lost it, which is exactly what #120 repairs.
 */
function seedUnionStore(projectId: string, foreignId: string, userVersion: number): void {
  const dbFile = getProjectDbFile(projectId);
  mkdirSync(dirname(dbFile), { recursive: true });
  const seed = new Database(dbFile);
  createEventsTable(seed);
  createObservationsTable(seed, userVersion >= 14);
  createV12ProjectionTables(seed);

  insertGenesis(seed, projectId, "Self");

  const selfObs = observationPayload("obs_self", projectId, "sess_self");
  insertEvent(seed, {
    id: "evt_obs_self",
    type: "observation.captured",
    projectId,
    scopeId: "sess_self",
    // Self-authored: since v11, appendEvent stamps the store's own projectId.
    sourceProjectId: projectId,
    payload: selfObs,
  });
  insertObservationRow(seed, selfObs);

  // The foreign member's genesis rides in with its entities (SoT-040 roster),
  // which is what makes this store a union log.
  insertGenesis(seed, foreignId, "Bob");

  const foreignObs = observationPayload("obs_bob", foreignId, "sess_bob");
  insertEvent(seed, {
    id: "evt_obs_bob",
    type: "observation.captured",
    projectId,
    scopeId: "sess_bob",
    sourceProjectId: foreignId,
    payload: foreignObs,
  });
  insertObservationRow(seed, foreignObs);

  seed.pragma(`user_version = ${userVersion}`);
  seed.close();
}

describe("observations lane backfill (#120)", () => {
  // The population the defect actually damaged: v14 ran, added the column, and
  // left the pre-existing foreign row NULL. An edit to v14's own body could
  // never reach these stores (runMigrations replays only from the store's
  // current user_version), which is why the backfill is a new entry.
  it("repairs a store that already ran v14 — foreign row left NULL — with no write", () => {
    const projectId = "proj_backfill_v14";
    const FOREIGN = "proj_backfill_bob";
    seedUnionStore(projectId, FOREIGN, 14);

    const db = getDb(projectId);
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(15);

    // Read-only from here down — no write to trigger a projection rebuild.
    const self = listRecentObservations(projectId, { limit: 10 });
    expect(self.map((o) => o.id)).toEqual(["obs_self"]);

    const union = listRecentObservations(projectId, { limit: 10, lane: "union" });
    expect(union.map((o) => o.id).sort()).toEqual(["obs_bob", "obs_self"]);
    expect(union.find((o) => o.id === "obs_bob")?.sourceProjectId).toBe(FOREIGN);
  });

  it("a v13 store upgrades straight through v14 + v15 without leaking the foreign row into self", () => {
    const projectId = "proj_backfill_v13";
    const FOREIGN = "proj_backfill_bob";
    seedUnionStore(projectId, FOREIGN, 13);

    const db = getDb(projectId);
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(15);

    // Self lane (the default, and the short-term tail a session injects):
    // the foreign observation must NOT be in it.
    const self = listRecentObservations(projectId, { limit: 10 });
    expect(self.map((o) => o.id)).toEqual(["obs_self"]);
    // The self observation is untouched — this restores a lane, it does not
    // rewrite self rows.
    expect("sourceProjectId" in self[0]!).toBe(false);

    // Union lane still shows BOTH — the foreign observation was relabelled,
    // not deleted — and carries its restored origin.
    const union = listRecentObservations(projectId, { limit: 10, lane: "union" });
    expect(union.map((o) => o.id).sort()).toEqual(["obs_bob", "obs_self"]);
    expect(union.find((o) => o.id === "obs_bob")?.sourceProjectId).toBe(FOREIGN);

    // The column itself was restored — not just the read path coincidentally
    // agreeing — since `laneWhere` filters on the column, not on `data`.
    const rows = db
      .prepare("SELECT id, source_project_id AS lane FROM observations ORDER BY id")
      .all() as Array<{ id: string; lane: string | null }>;
    expect(rows).toEqual([
      { id: "obs_bob", lane: FOREIGN },
      { id: "obs_self", lane: null },
    ]);
  });

  it("reads stay correct across repeated read-only opens (no write ever self-heals)", () => {
    const projectId = "proj_backfill_reopen";
    const FOREIGN = "proj_backfill_bob";
    seedUnionStore(projectId, FOREIGN, 14);

    for (let i = 0; i < 3; i++) {
      getDb(projectId);
      expect(listRecentObservations(projectId, { limit: 10 }).map((o) => o.id)).toEqual([
        "obs_self",
      ]);
      closeAll();
    }
  });

  it("a single-writer store (no foreign rows) is byte-identical after upgrade", () => {
    const projectId = "proj_backfill_solo";
    const dbFile = getProjectDbFile(projectId);
    mkdirSync(dirname(dbFile), { recursive: true });
    const seed = new Database(dbFile);
    createEventsTable(seed);
    createObservationsTable(seed, false);
    createV12ProjectionTables(seed);

    insertGenesis(seed, projectId, "Solo");
    const obs = observationPayload("obs_only", projectId, "sess_1");
    insertEvent(seed, {
      id: "evt_obs",
      type: "observation.captured",
      projectId,
      scopeId: "sess_1",
      sourceProjectId: projectId,
      payload: obs,
    });
    const rawData = JSON.stringify(obs);
    seed
      .prepare(
        `INSERT INTO observations (id, session_id, signal, created_at, data)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(obs.id, obs.sessionId, obs.signal, obs.createdAt, rawData);

    seed.pragma("user_version = 13");
    seed.close();

    const db = getDb(projectId);
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(15);

    // `data` compared as the exact original string: the backfill must not
    // re-serialize a row it has no reason to touch.
    const rows = db
      .prepare("SELECT id, source_project_id AS lane, data FROM observations")
      .all() as Array<{ id: string; lane: string | null; data: string }>;
    expect(rows).toEqual([{ id: "obs_only", lane: null, data: rawData }]);

    const self = listRecentObservations(projectId, { limit: 10 });
    expect(self.map((o) => o.id)).toEqual(["obs_only"]);
    expect("sourceProjectId" in self[0]!).toBe(false);
  });

  it("leaves a row with no capture event NULL rather than guessing a lane", () => {
    const projectId = "proj_backfill_orphan";
    const dbFile = getProjectDbFile(projectId);
    mkdirSync(dirname(dbFile), { recursive: true });
    const seed = new Database(dbFile);
    createEventsTable(seed);
    createObservationsTable(seed, false);
    createV12ProjectionTables(seed);

    insertGenesis(seed, projectId, "Self");
    // Projected row with no `observation.captured` event behind it. Should not
    // happen (the log is the only writer of this table), but the backfill must
    // not invent provenance for it.
    const orphan = observationPayload("obs_orphan", projectId, "sess_x");
    insertObservationRow(seed, orphan);

    seed.pragma("user_version = 13");
    seed.close();

    const db = getDb(projectId);
    const rows = db
      .prepare("SELECT id, source_project_id AS lane FROM observations")
      .all() as Array<{ id: string; lane: string | null }>;
    expect(rows).toEqual([{ id: "obs_orphan", lane: null }]);
  });
});

// #154 — the two weaknesses owner review left on PR #153's v15, now fixed by
// pointing v15 at #150's `backfillEntityTableLane`:
//
//  ① v15 adopted the FIRST `observation.captured` event per payload id, while
//     `reduceProjectState` overwrites the record on every capture. On an id
//     with more than one capture event the two disagree, so the backfill
//     produced a row a rebuild would never produce.
//  ② v15 materialized the whole table and the whole capture history at once.
//     The helper pages the table in fixed batches, and a batch boundary is
//     where a paging bug drops rows.
//
// Both suites below upgrade a store and read WITHOUT WRITING first, for the
// same reason the #120 suite does: a write would rebuild the projection and
// mask whatever the migration got wrong.

/**
 * A store carrying the CURRENT schema for every table (so
 * `rebuildProjectProjection` — which replaces all of them — can run against
 * it) but rewound to `userVersion` with the observation lanes never
 * populated, i.e. exactly what a store that had run v14 and stopped looks
 * like. Built by letting the real migrations create the tables on an empty
 * db and then winding `user_version` back, rather than by hand-writing the
 * DDL, so it cannot drift from the schema the rebuild expects.
 */
function seedAtCurrentSchema(
  projectId: string,
  seedRows: (db: Database.Database) => void,
  userVersion = 14,
): void {
  const dbFile = getProjectDbFile(projectId);
  mkdirSync(dirname(dbFile), { recursive: true });
  getDb(projectId);
  closeAll();

  const seed = new Database(dbFile);
  seedRows(seed);
  // Rows go in with the lane column left NULL (insertObservationRow does not
  // name it) — the v14 state this migration exists to repair.
  seed.pragma(`user_version = ${userVersion}`);
  seed.close();
}

function laneRows(db: Database.Database): Array<{ id: string; lane: string | null }> {
  return db
    .prepare("SELECT id, source_project_id AS lane FROM observations ORDER BY id")
    .all() as Array<{ id: string; lane: string | null }>;
}

describe("observations lane backfill — adoption order (#154 ①)", () => {
  // The equation this suite exists to pin: for ANY store, the lane the
  // migration writes == the lane a real rebuild would write. #120's original
  // v15 satisfied it only for ids with a single capture event; the point of
  // last-wins is that the equation holds unconditionally.
  it("matches rebuildProjectProjection when one id has two captures on different lanes", async () => {
    const projectId = "proj_backfill_dup";
    const FOREIGN = "proj_backfill_bob";

    seedAtCurrentSchema(projectId, (seed) => {
      insertGenesis(seed, projectId, "Self");
      insertGenesis(seed, FOREIGN, "Bob");

      // Two ids, one per direction of the disagreement — neither is caught by
      // a backfill that reads only the first event, and they fail differently:
      // `obs_ff` needs an UPDATE the old code skipped, `obs_sf` needs the old
      // code's UPDATE NOT to happen.
      //
      // obs_ff: captured foreign first, then self. The projected row is the
      // SECOND capture, so the rebuild leaves it on the self lane (NULL).
      const ffForeign = observationPayload("obs_ff", FOREIGN, "sess_bob");
      insertEvent(seed, {
        id: "evt_ff_1",
        type: "observation.captured",
        projectId,
        scopeId: "sess_bob",
        sourceProjectId: FOREIGN,
        payload: ffForeign,
      });
      const ffSelf = { ...observationPayload("obs_ff", projectId, "sess_self"), summary: "later" };
      insertEvent(seed, {
        id: "evt_ff_2",
        type: "observation.captured",
        projectId,
        scopeId: "sess_self",
        sourceProjectId: projectId,
        payload: ffSelf,
      });
      insertObservationRow(seed, ffSelf);

      // obs_sf: captured self first, then foreign — the rebuild puts it on
      // the foreign lane.
      const sfSelf = observationPayload("obs_sf", projectId, "sess_self");
      insertEvent(seed, {
        id: "evt_sf_1",
        type: "observation.captured",
        projectId,
        scopeId: "sess_self",
        sourceProjectId: projectId,
        payload: sfSelf,
      });
      const sfForeign = { ...observationPayload("obs_sf", FOREIGN, "sess_bob"), summary: "later" };
      insertEvent(seed, {
        id: "evt_sf_2",
        type: "observation.captured",
        projectId,
        scopeId: "sess_bob",
        sourceProjectId: FOREIGN,
        payload: sfForeign,
      });
      insertObservationRow(seed, sfForeign);
    });

    const db = getDb(projectId);
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(15);

    const afterBackfill = laneRows(db);
    expect(afterBackfill).toEqual([
      { id: "obs_ff", lane: null },
      { id: "obs_sf", lane: FOREIGN },
    ]);

    // The equation itself: replay the log through the projection writer and
    // the lanes must not move. (This is the first write in the test, and it
    // is the assertion — not setup.)
    await rebuildProjectProjection(projectId);
    expect(laneRows(getDb(projectId))).toEqual(afterBackfill);
  });

  it("keeps the byte-identity property on a repeated self capture", async () => {
    const projectId = "proj_backfill_dup_solo";

    const first = observationPayload("obs_rep", projectId, "sess_1");
    const second = { ...observationPayload("obs_rep", projectId, "sess_1"), summary: "later" };
    const rawData = JSON.stringify(second);

    seedAtCurrentSchema(projectId, (seed) => {
      insertGenesis(seed, projectId, "Solo");
      insertEvent(seed, {
        id: "evt_rep_1",
        type: "observation.captured",
        projectId,
        scopeId: "sess_1",
        sourceProjectId: projectId,
        payload: first,
      });
      insertEvent(seed, {
        id: "evt_rep_2",
        type: "observation.captured",
        projectId,
        scopeId: "sess_1",
        sourceProjectId: projectId,
        payload: second,
      });
      insertObservationRow(seed, second);
    });

    // Last-wins resolves to self here, and a self lane is still skipped
    // outright: `data` must come back as the exact bytes that went in.
    const rows = getDb(projectId)
      .prepare("SELECT id, source_project_id AS lane, data FROM observations")
      .all() as Array<{ id: string; lane: string | null; data: string }>;
    expect(rows).toEqual([{ id: "obs_rep", lane: null, data: rawData }]);
  });
});

describe("observations lane backfill — batch boundaries (#154 ②)", () => {
  // `backfillEntityTableLane` pages the table by rowid, 500 rows at a time,
  // so the migration no longer holds the whole table in memory. The risk that
  // buys is a paging bug at the seam, which shows up as rows silently left
  // un-backfilled. Both sizes below cross the seam twice; 1000 is an exact
  // multiple of the batch size (last page full, next page empty) and 1001 is
  // not (last page short), which are the two different loop exits.
  for (const total of [1000, 1001]) {
    it(`backfills every row of a ${total}-row store — no row dropped at a page boundary`, () => {
      const projectId = `proj_backfill_batch_${total}`;
      const FOREIGN = "proj_backfill_bob";
      // Every third observation is foreign, so both the UPDATE path and the
      // skip path land on either side of each boundary.
      const isForeign = (i: number): boolean => i % 3 === 0;
      const obsId = (i: number): string => `obs_${String(i).padStart(5, "0")}`;

      seedAtCurrentSchema(projectId, (seed) => {
        insertGenesis(seed, projectId, "Self");
        insertGenesis(seed, FOREIGN, "Bob");
        const insertMany = seed.transaction(() => {
          for (let i = 0; i < total; i++) {
            const foreign = isForeign(i);
            const observation = observationPayload(
              obsId(i),
              foreign ? FOREIGN : projectId,
              foreign ? "sess_bob" : "sess_self",
            );
            insertEvent(seed, {
              id: `evt_${obsId(i)}`,
              type: "observation.captured",
              projectId,
              scopeId: foreign ? "sess_bob" : "sess_self",
              sourceProjectId: foreign ? FOREIGN : projectId,
              payload: observation,
            });
            insertObservationRow(seed, observation);
          }
        });
        insertMany();
      });

      const db = getDb(projectId);
      expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(15);

      const rows = laneRows(db);
      expect(rows).toHaveLength(total);
      const expected = Array.from({ length: total }, (_, i) => ({
        id: obsId(i),
        lane: isForeign(i) ? FOREIGN : null,
      }));
      expect(rows).toEqual(expected);

      // Same statement the reader uses: nothing foreign leaked into the self
      // lane, at any page boundary.
      const selfCount = db
        .prepare("SELECT COUNT(*) AS n FROM observations WHERE source_project_id IS NULL")
        .get() as { n: number };
      expect(selfCount.n).toBe(expected.filter((row) => row.lane === null).length);
    });
  }
});

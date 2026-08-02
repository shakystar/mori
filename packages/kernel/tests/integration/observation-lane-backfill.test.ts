import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION } from "../../src/domain/common.js";
import { listRecentObservations } from "../../src/services/projection-store.js";
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

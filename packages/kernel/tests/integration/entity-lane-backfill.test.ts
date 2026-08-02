import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION } from "../../src/domain/common.js";
import { listSegments } from "../../src/services/segment-store.js";
import {
  listSessions,
  listTasks,
  listValidMemories,
  rebuildProjectProjection,
} from "../../src/services/projection-store.js";
import { searchProject } from "../../src/services/search-service.js";
import { closeAll, getDb } from "../../src/storage/db.js";
import { getProjectDbFile } from "../../src/storage/path-resolver.js";

// #150 — generalizes the #120/v15 `observations` backfill to the five v12
// tables (tasks/handoffs/sessions/memories/segments) + `search_fts`.
//
// Judgement recorded in the PR / issue: no real store can currently reach the
// "damaged" shape these fixtures hand-build (mori has never carried the
// union-sync mechanism that would write a foreign row — see the v12 comment
// in storage/db.ts) — this suite exists as defense-in-depth,
// proving the backfill mechanism is correct IF that mechanism is ever ported,
// while a separate test below pins down that today's (self-only) data is
// byte-identical after the upgrade (a provable no-op).
//
// Every test reads WITHOUT EVER WRITING after the seeded db is opened — a
// single write would trigger rebuildProjectProjection's replace-all and
// self-heal the very thing being tested (same discipline as
// observation-lane-backfill.test.ts).

const ts = "2026-01-01T00:00:00.000Z";
const SELF = "proj_entity_backfill_self";
const FOREIGN = "proj_entity_backfill_bob";

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-entity-backfill-"));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

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

function insertEvent(
  db: Database.Database,
  row: {
    id: string;
    type: string;
    projectId: string;
    scopeType: string;
    scopeId: string;
    sourceProjectId: string | null;
    payload: unknown;
  },
): void {
  db.prepare(
    `INSERT INTO events
       (id, schema_version, created_at, updated_at, type,
        project_id, scope_type, scope_id, actor, writer, source_project_id, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test', 'test', ?, ?)`,
  ).run(
    row.id,
    CURRENT_SCHEMA_VERSION,
    ts,
    ts,
    row.type,
    row.projectId,
    row.scopeType,
    row.scopeId,
    row.sourceProjectId,
    JSON.stringify(row.payload),
  );
}

function insertGenesis(db: Database.Database, projectId: string, title: string): void {
  insertEvent(db, {
    id: `evt_genesis_${projectId}`,
    type: "project.created",
    projectId,
    scopeType: "project",
    scopeId: projectId,
    sourceProjectId: projectId,
    payload: { id: projectId, title },
  });
}

// --- entity table DDL, at the shape each is BEFORE vs. AT/AFTER v12 --------

function createEntityTables(db: Database.Database, withLaneColumn: boolean): void {
  const lane = withLaneColumn ? ", source_project_id TEXT" : "";
  db.exec(`
    -- v14 added observations' own lane column separately from v12 (#74/#120);
    -- kept empty here (this suite is about the OTHER five tables), but the
    -- table must exist whenever a pinned version is high enough that v14/v15
    -- (which both touch it) are considered already-applied.
    CREATE TABLE observations (
      id TEXT PRIMARY KEY, session_id TEXT, signal TEXT, created_at TEXT,
      data TEXT NOT NULL ${lane}
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, status TEXT, workstream_id TEXT,
      created_at TEXT, updated_at TEXT, data TEXT NOT NULL ${lane}
    );
    CREATE TABLE handoffs (
      id TEXT PRIMARY KEY, data TEXT NOT NULL ${lane}
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, status TEXT, data TEXT NOT NULL ${lane}
    );
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, kind TEXT, salience INTEGER, created_at TEXT,
      invalid_at TEXT, superseded_by TEXT, deduped_by TEXT,
      last_accessed_at TEXT, injection_count INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL ${lane}
    );
    CREATE TABLE segments (
      id TEXT PRIMARY KEY, session_id TEXT, created_at TEXT NOT NULL,
      ordinal INTEGER, source TEXT, text TEXT NOT NULL ${lane}
    );
    CREATE VIRTUAL TABLE search_fts USING fts5(
      entity_id UNINDEXED, kind UNINDEXED, text
      ${withLaneColumn ? ", source_project_id UNINDEXED" : ""},
      tokenize='unicode61'
    );
  `);
}

function taskPayload(id: string, projectId: string) {
  return {
    id,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    projectId,
    workstreamId: undefined,
    title: `task ${id}`,
    description: "",
    status: "todo",
    priority: "medium",
    ownerType: "unassigned",
    goal: "",
    acceptanceCriteria: [],
    dependsOn: [],
    contextRefIds: [],
    decisionRefIds: [],
    ruleRefIds: [],
    openQuestions: [],
    riskNotes: [],
  };
}

function handoffPayload(id: string, projectId: string) {
  return {
    id,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    projectId,
    taskId: "task_x",
    fromActor: "a",
    toActor: "b",
    summary: `handoff ${id}`,
    nextAction: "",
    doneItems: [],
    remainingItems: [],
    requiredContextRefs: [],
    warnings: [],
    unresolvedQuestions: [],
    confidence: "medium",
  };
}

function sessionPayload(id: string, projectId: string) {
  return {
    id,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    projectId,
    actor: "claude",
    startedAt: ts,
    lastSeenAt: ts,
    status: "active",
  };
}

function memoryPayload(id: string, projectId: string) {
  return {
    id,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    projectId,
    kind: "insight",
    text: `memory ${id}`,
    salience: 5,
    sourceObservationIds: [],
  };
}

function insertRow(
  db: Database.Database,
  table: string,
  columns: string[],
  values: unknown[],
): void {
  const placeholders = columns.map(() => "?").join(", ");
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`).run(
    ...values,
  );
}

/** Project a row the way a pre-v16 store did: no lane on the row, whatever the event said. */
function insertTaskRow(db: Database.Database, p: ReturnType<typeof taskPayload>): void {
  insertRow(
    db,
    "tasks",
    ["id", "status", "workstream_id", "created_at", "updated_at", "data"],
    [p.id, p.status, p.workstreamId ?? null, p.createdAt, p.updatedAt, JSON.stringify(p)],
  );
}
function insertHandoffRow(db: Database.Database, p: ReturnType<typeof handoffPayload>): void {
  insertRow(db, "handoffs", ["id", "data"], [p.id, JSON.stringify(p)]);
}
function insertSessionRow(db: Database.Database, p: ReturnType<typeof sessionPayload>): void {
  insertRow(db, "sessions", ["id", "status", "data"], [p.id, p.status, JSON.stringify(p)]);
}
function insertMemoryRow(db: Database.Database, p: ReturnType<typeof memoryPayload>): void {
  insertRow(
    db,
    "memories",
    ["id", "kind", "salience", "created_at", "data"],
    [p.id, p.kind, p.salience, p.createdAt, JSON.stringify(p)],
  );
}
function insertSearchFtsRow(
  db: Database.Database,
  entityId: string,
  kind: string,
  text: string,
  withLaneColumn: boolean,
): void {
  if (withLaneColumn) {
    db.prepare(
      "INSERT INTO search_fts (entity_id, kind, text, source_project_id) VALUES (?, ?, ?, NULL)",
    ).run(entityId, kind, text);
  } else {
    db.prepare("INSERT INTO search_fts (entity_id, kind, text) VALUES (?, ?, ?)").run(
      entityId,
      kind,
      text,
    );
  }
}

/**
 * A store carrying one self + one foreign row in each of the four
 * event-log-derivable v12 tables (tasks/handoffs/sessions/memories), plus
 * matching `search_fts` rows — pinned at `userVersion` with NO lane recorded
 * anywhere on the projection side (exactly what a pre-v16 store looked like,
 * whether or not it happened to already have the v12 column).
 */
function seedUnionStore(userVersion: number): string {
  const dbFile = getProjectDbFile(SELF);
  mkdirSync(dirname(dbFile), { recursive: true });
  const seed = new Database(dbFile);
  createEventsTable(seed);
  createEntityTables(seed, userVersion >= 12);

  insertGenesis(seed, SELF, "Self");
  insertGenesis(seed, FOREIGN, "Bob");

  const selfTask = taskPayload("task_self", SELF);
  insertEvent(seed, {
    id: "evt_task_self",
    type: "task.created",
    projectId: SELF,
    scopeType: "task",
    scopeId: selfTask.id,
    sourceProjectId: SELF,
    payload: selfTask,
  });
  insertTaskRow(seed, selfTask);
  insertSearchFtsRow(seed, selfTask.id, "task", selfTask.title, userVersion >= 12);

  const bobTask = taskPayload("task_bob", FOREIGN);
  insertEvent(seed, {
    id: "evt_task_bob",
    type: "task.created",
    projectId: SELF,
    scopeType: "task",
    scopeId: bobTask.id,
    sourceProjectId: FOREIGN,
    payload: bobTask,
  });
  insertTaskRow(seed, bobTask);
  insertSearchFtsRow(seed, bobTask.id, "task", bobTask.title, userVersion >= 12);

  const selfHandoff = handoffPayload("handoff_self", SELF);
  insertEvent(seed, {
    id: "evt_handoff_self",
    type: "handoff.created",
    projectId: SELF,
    scopeType: "task",
    scopeId: "task_x",
    sourceProjectId: SELF,
    payload: selfHandoff,
  });
  insertHandoffRow(seed, selfHandoff);
  insertSearchFtsRow(seed, selfHandoff.id, "handoff", selfHandoff.summary, userVersion >= 12);

  const bobHandoff = handoffPayload("handoff_bob", FOREIGN);
  insertEvent(seed, {
    id: "evt_handoff_bob",
    type: "handoff.created",
    projectId: SELF,
    scopeType: "task",
    scopeId: "task_x",
    sourceProjectId: FOREIGN,
    payload: bobHandoff,
  });
  insertHandoffRow(seed, bobHandoff);
  insertSearchFtsRow(seed, bobHandoff.id, "handoff", bobHandoff.summary, userVersion >= 12);

  const selfSession = sessionPayload("session_self", SELF);
  insertEvent(seed, {
    id: "evt_session_self",
    type: "session.started",
    projectId: SELF,
    scopeType: "session",
    scopeId: selfSession.id,
    sourceProjectId: SELF,
    payload: selfSession,
  });
  insertSessionRow(seed, selfSession);

  const bobSession = sessionPayload("session_bob", FOREIGN);
  insertEvent(seed, {
    id: "evt_session_bob",
    type: "session.started",
    projectId: SELF,
    scopeType: "session",
    scopeId: bobSession.id,
    sourceProjectId: FOREIGN,
    payload: bobSession,
  });
  insertSessionRow(seed, bobSession);

  const selfMemory = memoryPayload("memory_self", SELF);
  insertEvent(seed, {
    id: "evt_memory_self",
    type: "memory.consolidated",
    projectId: SELF,
    scopeType: "project",
    scopeId: SELF,
    sourceProjectId: SELF,
    payload: selfMemory,
  });
  insertMemoryRow(seed, selfMemory);
  insertSearchFtsRow(seed, selfMemory.id, "memory", selfMemory.text, userVersion >= 12);

  const bobMemory = memoryPayload("memory_bob", FOREIGN);
  insertEvent(seed, {
    id: "evt_memory_bob",
    type: "memory.consolidated",
    projectId: SELF,
    scopeType: "project",
    scopeId: SELF,
    sourceProjectId: FOREIGN,
    payload: bobMemory,
  });
  insertMemoryRow(seed, bobMemory);
  insertSearchFtsRow(seed, bobMemory.id, "memory", bobMemory.text, userVersion >= 12);

  seed.pragma(`user_version = ${userVersion}`);
  seed.close();
  return dbFile;
}

describe("v12 entity-table + search_fts lane backfill (#150)", () => {
  it("repairs a store already past v12 (column exists, left NULL) with no write", () => {
    seedUnionStore(15);

    const db = getDb(SELF);
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(16);

    // Self-lane readers must exclude every foreign row.
    expect(listTasks(SELF).map((t) => t.id)).toEqual(["task_self"]);
    expect(listSessions(SELF).map((s) => s.id)).toEqual(["session_self"]);
    expect(listValidMemories(SELF).map((r) => r.memory.id)).toEqual(["memory_self"]);

    // Union-lane readers must surface both, with the foreign row correctly labelled.
    expect(
      listTasks(SELF, {}, "union")
        .map((t) => t.id)
        .sort(),
    ).toEqual(["task_bob", "task_self"]);
    expect(
      listSessions(SELF, "union")
        .map((s) => s.id)
        .sort(),
    ).toEqual(["session_bob", "session_self"]);
    expect(
      listValidMemories(SELF, "union")
        .map((r) => r.memory.id)
        .sort(),
    ).toEqual(["memory_bob", "memory_self"]);
    expect(
      listValidMemories(SELF, "union").find((r) => r.memory.id === "memory_bob")?.memory
        .sourceProjectId,
    ).toBe(FOREIGN);

    // handoffs has no list-by-lane reader (unlike the other four) — assert
    // directly against the table, the same information a `listHandoffs`
    // would expose.
    const handoffRows = db
      .prepare("SELECT id, source_project_id AS lane FROM handoffs ORDER BY id")
      .all() as Array<{ id: string; lane: string | null }>;
    expect(handoffRows).toEqual([
      { id: "handoff_bob", lane: FOREIGN },
      { id: "handoff_self", lane: null },
    ]);

    // The lane lands in the sinks a real rebuild writes, and ONLY those. The
    // three lane-KEYED tables keep the bare domain entity in `data` (the
    // reducer holds their lane in the state-map key), so a backfilled row's
    // `data` must stay byte-identical to what the projector stored...
    for (const [table, id, payload] of [
      ["tasks", "task_bob", taskPayload("task_bob", FOREIGN)],
      ["handoffs", "handoff_bob", handoffPayload("handoff_bob", FOREIGN)],
      ["sessions", "session_bob", sessionPayload("session_bob", FOREIGN)],
    ] as const) {
      const row = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string };
      expect(row.data).toBe(JSON.stringify(payload));
    }
    expect(listTasks(SELF, {}, "union").every((t) => !("sourceProjectId" in t))).toBe(true);

    // ...whereas `memories` is id-keyed with the lane ON the record
    // (MemoryRecord.sourceProjectId), so there `data` must carry it too.
    const bobMemoryRow = db.prepare("SELECT data FROM memories WHERE id = ?").get("memory_bob") as {
      data: string;
    };
    expect(bobMemoryRow.data).toBe(
      JSON.stringify({ ...memoryPayload("memory_bob", FOREIGN), sourceProjectId: FOREIGN }),
    );

    // search_fts: the mirrored lane must also be correct, independent of any
    // rebuild (this store never wrote, so reindexSearch's fixed-point never ran).
    const ftsRows = db
      .prepare("SELECT entity_id AS id, source_project_id AS lane FROM search_fts ORDER BY id")
      .all() as Array<{ id: string; lane: string | null }>;
    expect(ftsRows).toEqual([
      { id: "handoff_bob", lane: FOREIGN },
      { id: "handoff_self", lane: null },
      { id: "memory_bob", lane: FOREIGN },
      { id: "memory_self", lane: null },
      { id: "task_bob", lane: FOREIGN },
      { id: "task_self", lane: null },
    ]);
  });

  it("a pre-v12 store (v11) upgrades straight through v12..v16 without leaking foreign rows", () => {
    seedUnionStore(11);

    const db = getDb(SELF);
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(16);

    expect(listTasks(SELF).map((t) => t.id)).toEqual(["task_self"]);
    expect(listSessions(SELF).map((s) => s.id)).toEqual(["session_self"]);
    expect(listValidMemories(SELF).map((r) => r.memory.id)).toEqual(["memory_self"]);

    const taskRows = db
      .prepare("SELECT id, source_project_id AS lane FROM tasks ORDER BY id")
      .all() as Array<{ id: string; lane: string | null }>;
    expect(taskRows).toEqual([
      { id: "task_bob", lane: FOREIGN },
      { id: "task_self", lane: null },
    ]);
  });

  it("reads stay correct across repeated read-only opens (no write ever self-heals)", () => {
    seedUnionStore(14);

    for (let i = 0; i < 3; i++) {
      getDb(SELF);
      expect(listTasks(SELF).map((t) => t.id)).toEqual(["task_self"]);
      expect(listValidMemories(SELF).map((r) => r.memory.id)).toEqual(["memory_self"]);
      closeAll();
    }
  });

  it("leaves a row with no matching creation event NULL rather than guessing", () => {
    const dbFile = getProjectDbFile(SELF);
    mkdirSync(dirname(dbFile), { recursive: true });
    const seed = new Database(dbFile);
    createEventsTable(seed);
    createEntityTables(seed, false);
    insertGenesis(seed, SELF, "Self");

    // Projected row with no `task.created` behind it — should not happen (the
    // log is the only writer of this table), but the backfill must not invent
    // a lane for it.
    insertTaskRow(seed, taskPayload("task_orphan", SELF));
    seed.pragma("user_version = 11");
    seed.close();

    const db = getDb(SELF);
    const rows = db.prepare("SELECT id, source_project_id AS lane FROM tasks").all() as Array<{
      id: string;
      lane: string | null;
    }>;
    expect(rows).toEqual([{ id: "task_orphan", lane: null }]);
  });

  it("a single-writer (self-only) store is byte-identical after upgrade — the real-world no-op", () => {
    // This is the shape every REAL store has (per #150's judgement: mori has
    // never had a mechanism to write a foreign row) — pinning this down is
    // "백필을 돌려도 아무것도 바뀌지 않음을 테스트로 고정" from the issue body.
    const dbFile = getProjectDbFile(SELF);
    mkdirSync(dirname(dbFile), { recursive: true });
    const seed = new Database(dbFile);
    createEventsTable(seed);
    createEntityTables(seed, false);
    insertGenesis(seed, SELF, "Self");

    const task = taskPayload("task_only", SELF);
    insertEvent(seed, {
      id: "evt_task_only",
      type: "task.created",
      projectId: SELF,
      scopeType: "task",
      scopeId: task.id,
      sourceProjectId: SELF,
      payload: task,
    });
    insertTaskRow(seed, task);
    const rawTaskData = JSON.stringify(task);

    const memory = memoryPayload("memory_only", SELF);
    insertEvent(seed, {
      id: "evt_memory_only",
      type: "memory.consolidated",
      projectId: SELF,
      scopeType: "project",
      scopeId: SELF,
      sourceProjectId: SELF,
      payload: memory,
    });
    insertMemoryRow(seed, memory);
    const rawMemoryData = JSON.stringify(memory);

    insertSearchFtsRow(seed, task.id, "task", task.title, false);

    seed.pragma("user_version = 11");
    seed.close();

    const db = getDb(SELF);
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(16);

    const taskRows = db
      .prepare("SELECT id, source_project_id AS lane, data FROM tasks")
      .all() as Array<{ id: string; lane: string | null; data: string }>;
    expect(taskRows).toEqual([{ id: "task_only", lane: null, data: rawTaskData }]);

    const memoryRows = db
      .prepare("SELECT id, source_project_id AS lane, data FROM memories")
      .all() as Array<{ id: string; lane: string | null; data: string }>;
    expect(memoryRows).toEqual([{ id: "memory_only", lane: null, data: rawMemoryData }]);

    const ftsRows = db
      .prepare("SELECT entity_id AS id, source_project_id AS lane FROM search_fts")
      .all() as Array<{ id: string; lane: string | null }>;
    expect(ftsRows).toEqual([{ id: "task_only", lane: null }]);
  });

  it("search_fts stays self-scoped after a reindexSearch:false rebuild", async () => {
    // #150's own axis (absent from #120): the hot telemetry path rebuilds the
    // projection TABLES from the event log but deliberately leaves `search_fts`
    // alone (projection-store.ts RebuildProjectProjectionOptions). So the table
    // lanes self-heal on that path while the index lanes do not — if v16 had
    // not already corrected `search_fts`, search would keep serving the foreign
    // row as self forever, with no write ever fixing it.
    //
    // Unlike the fixtures above (hand-built minimal DDL, never written to),
    // this one needs the REAL head schema so a services/ writer can run against
    // it: let the ladder build it, then rewind to v15 and re-damage the lanes
    // exactly as a pre-v16 upgrade left them, so reopening runs v16 alone.
    getDb(SELF);
    closeAll();

    const seed = new Database(getProjectDbFile(SELF));
    insertGenesis(seed, SELF, "Self");
    insertGenesis(seed, FOREIGN, "Bob");

    const selfTask = taskPayload("task_self", SELF);
    const bobTask = taskPayload("task_bob", FOREIGN);
    for (const [task, lane] of [
      [selfTask, SELF],
      [bobTask, FOREIGN],
    ] as const) {
      insertEvent(seed, {
        id: `evt_${task.id}`,
        type: "task.created",
        projectId: SELF,
        scopeType: "task",
        scopeId: task.id,
        sourceProjectId: lane,
        payload: task,
      });
      seed
        .prepare(
          "INSERT INTO tasks (id, status, created_at, updated_at, source_project_id, data) " +
            "VALUES (?, ?, ?, ?, NULL, ?)",
        )
        .run(task.id, task.status, task.createdAt, task.updatedAt, JSON.stringify(task));
      // NULL lane on the index row — what v12's search_fts re-create left behind.
      seed
        .prepare(
          "INSERT INTO search_fts (entity_id, kind, text, source_project_id) VALUES (?, 'task', ?, NULL)",
        )
        .run(task.id, task.title);
    }

    seed.pragma("user_version = 15");
    seed.close();

    getDb(SELF);
    await rebuildProjectProjection(SELF, { reindexSearch: false });

    expect(searchProject(SELF, "task").map((hit) => hit.entityId)).toEqual(["task_self"]);
    expect(
      searchProject(SELF, "task", 10, "union")
        .map((hit) => hit.entityId)
        .sort(),
    ).toEqual(["task_bob", "task_self"]);
    expect(
      searchProject(SELF, "task", 10, "union").find((hit) => hit.entityId === "task_bob")
        ?.sourceProjectId,
    ).toBe(FOREIGN);
  });

  it("segments are left untouched — no domain event backs the table, so there is nothing to backfill", () => {
    const dbFile = getProjectDbFile(SELF);
    mkdirSync(dirname(dbFile), { recursive: true });
    const seed = new Database(dbFile);
    createEventsTable(seed);
    createEntityTables(seed, false);
    insertGenesis(seed, SELF, "Self");
    seed
      .prepare(
        "INSERT INTO segments (id, session_id, created_at, ordinal, source, text) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("seg_1", "session_self", ts, 0, "user", "raw transcript text");
    insertSearchFtsRow(seed, "seg_1", "segment", "raw transcript text", false);
    seed.pragma("user_version = 11");
    seed.close();

    const db = getDb(SELF);
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(16);

    expect(listSegments(SELF).map((s) => s.id)).toEqual(["seg_1"]);
    const segRows = db
      .prepare("SELECT id, source_project_id AS lane FROM segments")
      .all() as Array<{ id: string; lane: string | null }>;
    expect(segRows).toEqual([{ id: "seg_1", lane: null }]);

    // search_fts still mirrors segments.source_project_id (unconditionally
    // correct since segments only ever holds self rows) — not left stale.
    const ftsRows = db
      .prepare("SELECT entity_id AS id, source_project_id AS lane FROM search_fts")
      .all() as Array<{ id: string; lane: string | null }>;
    expect(ftsRows).toEqual([{ id: "seg_1", lane: null }]);
  });
});

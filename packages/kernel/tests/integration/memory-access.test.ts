/**
 * #235 (#189 C) — reinforcement telemetry lives in its own `memory_access`
 * table (v17) instead of on the `memories` row: the read path that joins the
 * two, the observe-only contract of `bumpMemoryInjections`, and the v16 -> v17
 * migration that carries existing values across.
 *
 * The race this separation removes is covered by
 * memory-access-rebuild-race.test.ts.
 */

import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION } from "../../src/domain/common.js";
import { createProject } from "../../src/domain/entities.js";
import {
  bumpMemoryInjections,
  getMemory,
  listValidMemories,
  rebuildProjectProjection,
  touchMemoryAccess,
} from "../../src/services/projection-store.js";
import { closeAll, getDb } from "../../src/storage/db.js";
import { appendEvent } from "../../src/storage/event-store.js";
import { getProjectDbFile } from "../../src/storage/path-resolver.js";

const CREATED_AT = "2026-06-15T00:00:00.000Z";
const ACCESSED_AT = "2026-06-15T09:30:00.000Z";

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-memory-access-"));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

function memoryPayload(id: string, projectId: string, text: string) {
  return {
    id,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    projectId,
    kind: "insight",
    text,
    salience: 5,
    sourceObservationIds: [],
  };
}

/** A live store with two consolidated memories and nothing reinforced yet. */
async function seedProject(): Promise<string> {
  const project = createProject({ title: "access", rootPath: "/tmp/access" });
  const projectId = project.id;
  await appendEvent({
    type: "project.created",
    projectId,
    scopeType: "project",
    scopeId: projectId,
    actor: "test",
    payload: project,
  });
  for (const [id, text] of [
    ["mem_hot", "the reinforced one"],
    ["mem_cold", "never injected"],
  ]) {
    await appendEvent({
      type: "memory.consolidated",
      projectId,
      scopeType: "project",
      scopeId: projectId,
      actor: "test",
      payload: memoryPayload(id!, projectId, text!) as never,
    });
  }
  await rebuildProjectProjection(projectId);
  return projectId;
}

function accessRow(
  projectId: string,
  memoryId: string,
): { last_accessed_at: string | null; injection_count: number } | undefined {
  return getDb(projectId)
    .prepare("SELECT last_accessed_at, injection_count FROM memory_access WHERE memory_id = ?")
    .get(memoryId) as { last_accessed_at: string | null; injection_count: number } | undefined;
}

describe("memory_access read path", () => {
  it("lists memories that have never been reinforced alongside those that have", async () => {
    const projectId = await seedProject();
    touchMemoryAccess(projectId, ["mem_hot"], ACCESSED_AT);

    // `memory_access` has a row for mem_hot only, so an INNER JOIN here would
    // drop mem_cold — i.e. drop every memory that was never injected, which is
    // most of them on a young store.
    const rows = new Map(listValidMemories(projectId).map((row) => [row.memory.id, row]));
    expect([...rows.keys()].sort()).toEqual(["mem_cold", "mem_hot"]);
    expect(rows.get("mem_hot")?.lastAccessedAt).toBe(ACCESSED_AT);
    expect(rows.get("mem_cold")?.lastAccessedAt).toBeUndefined();
  });
});

describe("bumpMemoryInjections", () => {
  it("counts the injection without stamping last_accessed_at (#62 observe-only)", async () => {
    const projectId = await seedProject();

    bumpMemoryInjections(projectId, ["mem_cold"]);
    bumpMemoryInjections(projectId, ["mem_cold"]);

    expect(accessRow(projectId, "mem_cold")?.injection_count).toBe(2);
    expect(getMemory(projectId, "mem_cold")?.lastAccessedAt).toBeUndefined();
  });
});

/**
 * A store fully migrated through v16, carrying reinforcement values in the
 * shape v6/v9 gave them: two columns on the `memories` row. Only v17 runs from
 * this pin, and it reads `memories` alone, so that is the only projection
 * table the fixture needs.
 */
function seedV16Store(projectId: string): void {
  const dbFile = getProjectDbFile(projectId);
  mkdirSync(dirname(dbFile), { recursive: true });
  const seed = new Database(dbFile);
  seed.exec(`
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, schema_version TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, type TEXT NOT NULL,
      project_id TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL,
      actor TEXT NOT NULL, writer TEXT, source_project_id TEXT, payload TEXT NOT NULL
    );
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, kind TEXT, salience INTEGER, created_at TEXT,
      invalid_at TEXT, superseded_by TEXT, last_accessed_at TEXT,
      deduped_by TEXT, injection_count INTEGER NOT NULL DEFAULT 0,
      source_project_id TEXT, data TEXT NOT NULL
    );
  `);
  const insert = seed.prepare(
    `INSERT INTO memories (id, kind, salience, created_at, last_accessed_at, injection_count, data)
     VALUES (?, 'insight', 5, ?, ?, ?, ?)`,
  );
  const hot = memoryPayload("mem_legacy_hot", projectId, "reinforced before the upgrade");
  insert.run(hot.id, CREATED_AT, ACCESSED_AT, 3, JSON.stringify(hot));
  const cold = memoryPayload("mem_legacy_cold", projectId, "never injected before the upgrade");
  insert.run(cold.id, CREATED_AT, null, 0, JSON.stringify(cold));

  seed.pragma("user_version = 16");
  seed.close();
}

describe("v16 -> v17 reinforcement migration", () => {
  it("carries existing reinforcement across so readers see the same values", () => {
    const projectId = "proj_memory_access_v16";
    seedV16Store(projectId);

    // Opening the store runs v17. Nothing is written afterwards: a write would
    // trigger a rebuild and could mask a migration that lost the values.
    expect(getMemory(projectId, "mem_legacy_hot")?.lastAccessedAt).toBe(ACCESSED_AT);
    expect(getMemory(projectId, "mem_legacy_cold")?.lastAccessedAt).toBeUndefined();
    expect(accessRow(projectId, "mem_legacy_hot")?.injection_count).toBe(3);
  });
});

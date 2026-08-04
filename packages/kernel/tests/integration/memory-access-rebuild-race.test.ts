/**
 * #235 (#189 C) — a reinforcement write that lands WHILE a replace-all rebuild
 * is in flight must survive it.
 *
 * Before this issue, `last_accessed_at`/`injection_count` lived on the
 * `memories` row, which `rebuildProjectProjection` DELETEs and re-inserts. The
 * rebuild therefore SELECTed both columns into a map first and wrote them back
 * on re-insert — a read-modify-write spanning the whole transaction, while the
 * only writers of those columns (`touchMemoryAccess`, reached from
 * `transformContext`) run outside any lock. A stamp that landed after that
 * SELECT and before the re-insert was silently reverted, and the losing writer
 * saw nothing: its own UPDATE really had succeeded.
 *
 * Why a mock is unavoidable here (TESTING.md "예외: 타이밍 레이스·장애 주입"):
 * the losing window is INSIDE better-sqlite3's synchronous transaction. There
 * is no await in it, so two async flows in one process can never interleave
 * there, and a second connection cannot either — it would block on the write
 * lock the rebuild holds and commit after it. The real interleave is
 * cross-process. So the seam is injected at the one point that names the window
 * without naming any implementation of it: the FIRST `DELETE` of the
 * replace-all wipe, i.e. the rebuild has committed to replacing the projection
 * but has not yet re-inserted the memory rows. Running the concurrent write
 * from there on the same connection reproduces the ordering a second process
 * produces, deterministically.
 *
 * Only `getDb` is replaced, only the armed statement is wrapped (every other
 * call passes through the real implementation), and the assertion is the
 * observable final state — the reinforcement stamp a reader gets back — not the
 * mock's call log. Restore the carry-over in `rebuildProjectProjection` and
 * this test fails.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CURRENT_SCHEMA_VERSION } from "../../src/domain/common.js";
import { createProject } from "../../src/domain/entities.js";
import {
  getMemory,
  rebuildProjectProjection,
  touchMemoryAccess,
} from "../../src/services/projection-store.js";
import { closeAll } from "../../src/storage/db.js";
import { appendEvent } from "../../src/storage/event-store.js";

/**
 * The concurrent write to run once, from inside the rebuild's replace-all
 * wipe. Cleared as it fires, so arming is explicit and one-shot: the store
 * setup that precedes the race runs untouched.
 */
const seam = vi.hoisted(() => ({ concurrentWrite: undefined as (() => void) | undefined }));

vi.mock("../../src/storage/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/storage/db.js")>();

  /** Fire the armed write immediately after this statement's `run()` returns. */
  const armStatement = (stmt: Database.Statement): Database.Statement =>
    new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") return value;
        const fn = value as (...args: unknown[]) => unknown;
        if (prop !== "run") return fn.bind(target);
        return (...args: unknown[]) => {
          const result = fn.apply(target, args);
          const write = seam.concurrentWrite;
          seam.concurrentWrite = undefined;
          write?.();
          return result;
        };
      },
    });

  const wrap = (db: Database.Database): Database.Database =>
    new Proxy(db, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") return value;
        const fn = value as (...args: unknown[]) => unknown;
        if (prop !== "prepare") return fn.bind(target);
        return (...args: unknown[]) => {
          const stmt = fn.apply(target, args) as Database.Statement;
          // First table of the replace-all wipe loop: the projection is being
          // replaced, the memory rows are not back yet.
          const armed = seam.concurrentWrite !== undefined && args[0] === "DELETE FROM projects";
          return armed ? armStatement(stmt) : stmt;
        };
      },
    });

  return { ...actual, getDb: (projectId: string) => wrap(actual.getDb(projectId)) };
});

let sandbox: string;
let projectId: string;
const CREATED_AT = "2026-06-15T00:00:00.000Z";
const ACCESSED_AT = "2026-06-15T09:30:00.000Z";

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-access-race-"));
  process.env.MEMORIZE_ROOT = sandbox;

  const project = createProject({ title: "race", rootPath: "/tmp/race" });
  projectId = project.id;
  await appendEvent({
    type: "project.created",
    projectId,
    scopeType: "project",
    scopeId: projectId,
    actor: "test",
    payload: project,
  });
  await appendEvent({
    type: "memory.consolidated",
    projectId,
    scopeType: "project",
    scopeId: projectId,
    actor: "test",
    payload: {
      id: "mem_race",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      projectId,
      kind: "insight",
      text: "a memory that gets reinforced mid-rebuild",
      salience: 5,
      sourceObservationIds: [],
    } as never,
  });
  await rebuildProjectProjection(projectId);
});

afterEach(async () => {
  seam.concurrentWrite = undefined;
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe("reinforcement vs. replace-all rebuild", () => {
  it("keeps a stamp written while the rebuild is replacing the projection", async () => {
    seam.concurrentWrite = () => touchMemoryAccess(projectId, ["mem_race"], ACCESSED_AT);

    await rebuildProjectProjection(projectId);

    // Guard against a vacuous pass: if the seam never fired there was no race.
    expect(seam.concurrentWrite, "the concurrent write must have run").toBeUndefined();
    expect(getMemory(projectId, "mem_race")?.lastAccessedAt).toBe(ACCESSED_AT);
  });
});

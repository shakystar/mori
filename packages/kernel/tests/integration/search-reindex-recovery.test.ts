/**
 * #284 (#189 residue ㉯, cutting #282's recommendation) — a `reindexSearch:
 * true` rebuild that loses its compare-and-swap leaves its boundary's memories
 * in the projection tables but out of `search_fts`, and its caller
 * (`consolidateBoundary`) advances the cursor anyway, so that window is never
 * rescanned. `rebuildProjectProjection` now closes the gap itself with a
 * write-ahead marker in `meta`: the NEXT rebuild of the project, including the
 * `reindexSearch: false` one every capture runs, is promoted to a true reindex.
 *
 * Why a mock is unavoidable here (TESTING.md "예외: 타이밍 레이스·장애 주입"):
 * the gap only exists after a LOST CAS, and the CAS is lost only when another
 * writer moves the head between this rebuild's `readEvents` and the write
 * transaction it opens after its `await`s — cross-process by construction
 * (`storage/project-lock.ts`'s T1–T5). One process cannot schedule itself into
 * that window, and a second connection would block on the write lock the
 * transaction holds and commit after it, which is the ordering that was never
 * in question. So the seam is the same one `projection-rebuild-cas.test.ts`
 * already uses — `readEvents` returning, i.e. the snapshot is taken and nothing
 * is written yet — reused here to ARM the failure rather than to study it.
 *
 * Only `readEvents` is replaced (everything else passes through
 * `importOriginal`), only an explicitly armed call does anything different, and
 * both assertions are the observable final state — what `searchProject`
 * returns — never the marker's value, the meta row's existence, or the mock's
 * call log.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConsolidatedMemory, createProject } from "../../src/domain/entities.js";
import { rebuildProjectProjection } from "../../src/services/projection-store.js";
import { searchProject } from "../../src/services/search-service.js";
import { closeAll, getDb } from "../../src/storage/db.js";
import { appendEvent } from "../../src/storage/event-store.js";

/**
 * The concurrent append to run once the rebuild has taken its snapshot, which
 * is what costs that rebuild its compare-and-swap. `keepArmed` keeps the store
 * moving through every retry so the rebuild exhausts them and returns
 * `{ committed: false }`; the default is one-shot, so fixture setup runs
 * untouched.
 */
const seam = vi.hoisted(() => ({
  afterSnapshot: undefined as (() => Promise<void>) | undefined,
  keepArmed: false,
}));

vi.mock("../../src/storage/event-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/storage/event-store.js")>();
  return {
    ...actual,
    readEvents: async (projectId: string) => {
      const events = await actual.readEvents(projectId);
      const concurrent = seam.afterSnapshot;
      if (!seam.keepArmed) seam.afterSnapshot = undefined;
      await concurrent?.();
      // The snapshot as it was BEFORE the concurrent writer ran — exactly what
      // the dispossessed holder is left holding.
      return events;
    },
  };
});

let sandbox: string;
let projectId: string;

/** Append one consolidated memory to the log (no projection write of its own). */
async function appendMemory(text: string): Promise<string> {
  const memory = createConsolidatedMemory({ projectId, kind: "progress", text, salience: 5 });
  await appendEvent({
    type: "memory.consolidated",
    projectId,
    scopeType: "project",
    scopeId: projectId,
    actor: "test",
    payload: memory,
  });
  return memory.id;
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-reindex-recovery-"));
  process.env.MEMORIZE_ROOT = sandbox;

  const project = createProject({ title: "reindex", rootPath: "/tmp/reindex" });
  projectId = project.id;
  await appendEvent({
    type: "project.created",
    projectId,
    scopeType: "project",
    scopeId: projectId,
    actor: "test",
    payload: project,
  });
  // Leaves the store with an empty `search_fts` and no marker outstanding.
  await rebuildProjectProjection(projectId);
});

afterEach(async () => {
  seam.afterSnapshot = undefined;
  seam.keepArmed = false;
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe("search_fts gap left by a rebuild that lost its compare-and-swap", () => {
  it("is closed by the next rebuild even when that one asked not to reindex", async () => {
    const memoryId = await appendMemory("gramophone recovered after a lost swap");

    // Keep the log moving under every attempt so the true-reindex exhausts its
    // retries and writes nothing at all.
    seam.keepArmed = true;
    seam.afterSnapshot = async () => {
      await appendMemory("another writer, still going");
    };
    const lost = await rebuildProjectProjection(projectId, { reindexSearch: true });
    seam.keepArmed = false;
    seam.afterSnapshot = undefined;

    expect(lost.committed).toBe(false);
    expect(searchProject(projectId, "gramophone")).toEqual([]);

    // The capture path's rebuild — it asks for no reindex, and before #284 it
    // would have left the memory unsearchable indefinitely.
    await rebuildProjectProjection(projectId, { reindexSearch: false });

    expect(searchProject(projectId, "gramophone").map((hit) => hit.entityId)).toEqual([memoryId]);
  });

  it("is not invented when no rebuild is outstanding, so a false rebuild still skips the index", async () => {
    // A row no rebuild can re-derive: it survives only if `search_fts` is
    // never wiped. Promotion would DELETE it on the way to repopulating.
    getDb(projectId)
      .prepare(
        "INSERT INTO search_fts (entity_id, kind, source_project_id, text) " +
          "VALUES (?, ?, NULL, ?)",
      )
      .run("sentinel", "memory", "phonograph");

    // Twice: a `false` rebuild that armed the marker itself would degrade the
    // system into the always-reindex #282 rejected, and the second run is what
    // catches it.
    await rebuildProjectProjection(projectId, { reindexSearch: false });
    await rebuildProjectProjection(projectId, { reindexSearch: false });

    expect(searchProject(projectId, "phonograph").map((hit) => hit.entityId)).toEqual(["sentinel"]);
  });
});

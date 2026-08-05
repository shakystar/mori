/**
 * #270 (#263 candidate ①, #189 residue) — `rebuildProjectProjection`'s
 * replace-all must not commit a projection computed from a log snapshot the
 * log has already moved past.
 *
 * Why a mock is unavoidable here (TESTING.md "예외: 타이밍 레이스·장애 주입"):
 * the losing window opens between the rebuild's own `readEvents` and the write
 * transaction it opens after its `await`s, and the writer that has to land
 * inside it is ANOTHER PROCESS — `storage/project-lock.ts`'s T1–T5, where a
 * successor takes the lock and runs its own append + rebuild while the
 * dispossessed holder is still computing. One process cannot schedule itself
 * into that window (there is no suspension point a second async flow could be
 * resumed at deterministically), and a second connection cannot reproduce it
 * either: it would block on the write lock the rebuild's transaction holds and
 * commit after it, which is the ordering that was never in question.
 *
 * So the seam is injected at the one point that names the window without
 * naming any implementation of it: `readEvents` returning — the snapshot the
 * rebuild is about to compute from has just been taken, and nothing has been
 * written yet. Running the successor's whole boundary from there reproduces
 * the cross-process ordering deterministically.
 *
 * Only `readEvents` is replaced (everything else in the module passes through
 * `importOriginal`), only an explicitly armed call does anything different,
 * and the assertions are the observable final state — which memories the
 * projection returns, and whether it was written at all — never the mock's
 * call log.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConsolidatedMemory, createProject } from "../../src/domain/entities.js";
import {
  listValidMemories,
  rebuildProjectProjection,
} from "../../src/services/projection-store.js";
import { closeAll } from "../../src/storage/db.js";
import { appendEvent } from "../../src/storage/event-store.js";

/**
 * The concurrent work to run once the rebuild has taken its snapshot.
 * `keepArmed` distinguishes the single successor of the race case from the
 * store that never stops moving in the retry-exhaustion case; the default is
 * one-shot, so the fixture setup that precedes a race runs untouched.
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
  sandbox = await mkdtemp(join(tmpdir(), "mori-rebuild-cas-"));
  process.env.MEMORIZE_ROOT = sandbox;

  const project = createProject({ title: "cas", rootPath: "/tmp/cas" });
  projectId = project.id;
  await appendEvent({
    type: "project.created",
    projectId,
    scopeType: "project",
    scopeId: projectId,
    actor: "test",
    payload: project,
  });
  await rebuildProjectProjection(projectId);
});

afterEach(async () => {
  seam.afterSnapshot = undefined;
  seam.keepArmed = false;
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe("replace-all rebuild vs. a log that moved under it", () => {
  it("keeps a successor's memories that landed after this rebuild's snapshot", async () => {
    const ownId = await appendMemory("the dispossessed holder's own memory");

    // The successor: a whole boundary of its own — append plus the rebuild
    // that projects it — landing while this rebuild holds only its snapshot.
    let successorId = "";
    seam.afterSnapshot = async () => {
      successorId = await appendMemory("the successor's memory");
      await rebuildProjectProjection(projectId);
    };

    const result = await rebuildProjectProjection(projectId);

    // Guard against a vacuous pass: if the seam never fired there was no race.
    expect(seam.afterSnapshot, "the successor boundary must have run").toBeUndefined();
    expect(result.committed).toBe(true);
    expect(
      listValidMemories(projectId)
        .map((row) => row.memory.id)
        .sort(),
    ).toEqual([ownId, successorId].sort());
  });

  it("writes nothing and reports it when the log keeps moving past every retry", async () => {
    await appendMemory("a memory this rebuild would have projected");

    // Every snapshot is invalidated before the write transaction can take it.
    seam.keepArmed = true;
    seam.afterSnapshot = async () => {
      await appendMemory("another writer, still going");
    };

    const result = await rebuildProjectProjection(projectId);

    expect(result.committed).toBe(false);
    // Nothing was written — the projection is still the empty one the fixture
    // rebuilt before any memory was appended.
    expect(listValidMemories(projectId)).toEqual([]);
  });
});

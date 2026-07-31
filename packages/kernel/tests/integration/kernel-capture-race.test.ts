/**
 * #132, PR #127 Codex P1 — the capture read-modify-write, forced to interleave.
 *
 * `captureObservation` appends the observation and then rebuilds the projection
 * by REPLACING it from a snapshot of the event log. Snapshot and replace are
 * separated by an await, so two writers can interleave: the one that read FIRST
 * and committed LAST overwrites the projection with a snapshot that predates the
 * other's append. The observation survives in the event log and disappears from
 * the projection indefinitely — invisible, because only search results change.
 *
 * Two `SqliteMemoryKernel` instances over one `projectId` stand in for two mori
 * processes on one working root. Left to chance they step in lockstep and the
 * later commit happens to be the fuller one, so the bug hides; this file makes
 * the losing order deterministic by delaying the FIRST projection read past the
 * second writer's whole capture. Remove `withProjectLock` from `observe` and
 * this test fails.
 *
 * The delay is injected into `readEvents` rather than simulated with a fake
 * clock because the window being tested IS that await — a fake clock would
 * remove exactly the thing under test.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  observedShell,
  SqliteMemoryKernel,
  type ObservedToolCall,
} from "../../src/kernel/sqlite-memory-kernel.js";
import { listRecentObservations } from "../../src/services/projection-store.js";
import { closeAll } from "../../src/storage/db.js";
import { readEvents } from "../../src/storage/event-store.js";

/**
 * One delay (ms) per upcoming `readEvents` call, consumed in call order;
 * an empty queue means no delay. Armed by the test, so the store setup that
 * precedes the race runs at full speed.
 */
const schedule = vi.hoisted(() => ({ delaysMs: [] as number[] }));

vi.mock("../../src/storage/event-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/storage/event-store.js")>();
  return {
    ...actual,
    readEvents: async (projectId: string) => {
      const events = await actual.readEvents(projectId);
      const delayMs = schedule.delaysMs.shift() ?? 0;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return events;
    },
  };
});

type FakeEvent = ObservedToolCall;

let sandbox: string;
const projectId = "proj_capture_race_test";

function kernelFor(): SqliteMemoryKernel<string, FakeEvent> {
  return new SqliteMemoryKernel<string, FakeEvent>({
    projectId,
    actor: "mori",
    project: { title: "capture race", rootPath: sandbox },
    observeEvent: (event) => event,
  });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-capture-race-"));
  process.env.MEMORIZE_ROOT = sandbox;
  schedule.delaysMs.length = 0;
});

afterEach(async () => {
  closeAll();
  schedule.delaysMs.length = 0;
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe("interleaved capture across two kernel instances", () => {
  it("keeps both observations in the projection when the first writer commits last", async () => {
    // Genesis up front, so this case isolates the capture race from bootstrap.
    const seed = kernelFor();
    seed.observe(observedShell({ toolName: "bash", command: 'git commit -m "seed"' }));
    await seed.drain();

    // The next projection read — the first writer's — returns its snapshot only
    // after the second writer has appended AND committed. Without the lock that
    // makes the first writer's replace-all the last write and the stale one.
    schedule.delaysMs.push(200);

    const first = kernelFor();
    const second = kernelFor();
    first.observe(observedShell({ toolName: "bash", command: 'git commit -m "from-first"' }));
    // Enough of a head start that "first" is unambiguously the earlier reader,
    // and far below the 200ms delay it is holding.
    await new Promise((resolve) => setTimeout(resolve, 30));
    second.observe(observedShell({ toolName: "bash", command: 'git commit -m "from-second"' }));

    await Promise.all([first.drain(), second.drain()]);

    const logged = (await readEvents(projectId)).filter(
      (event) => event.type === "observation.captured",
    );
    expect(logged).toHaveLength(3);

    const projected = listRecentObservations(projectId, { limit: 10 });
    const summaries = projected.map((observation) => observation.summary ?? "").join("\n");
    expect(summaries).toContain("from-first");
    // The one the stale replace-all drops when `observe` is not serialized.
    expect(summaries).toContain("from-second");
    expect(projected).toHaveLength(logged.length);
  });
});

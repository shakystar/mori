/**
 * #236 (#189 B) — the genesis bootstrap race `kernel-project-lock.test.ts`
 * documents but cannot reproduce: `ensureGenesis`'s `hasGenesisEvent` check and
 * its `appendEvent` have no await between them (better-sqlite3 is synchronous),
 * so two REAL kernel instances in one process can never observe the gap —
 * `withProjectLock` (#132) also serializes them, so by the time the second
 * kernel's `ensureGenesis` runs, the first has already committed for real and
 * `hasGenesisEvent` truthfully says so.
 *
 * `vi.mock` on an internal module is otherwise off-limits (TESTING.md) — this
 * file is the same documented exception `kernel-capture-race.test.ts` uses
 * ("예외: 타이밍 레이스·장애 주입"): it lies to the SECOND kernel only, making
 * `hasGenesisEvent` report `false` even though the first kernel's genesis is
 * already durable, which is exactly what a real second PROCESS would see if it
 * ran its own check before either process had appended anything. What happens
 * after that lie — the insert, the database's rejection of it, and the
 * kernel's recovery — is all real; only the check is faked. A dedicated file
 * because the mock is module-scoped and would otherwise affect every other
 * genesis test in the suite.
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

/** Consumed by the NEXT `hasGenesisEvent` call only; real afterwards. */
const schedule = vi.hoisted(() => ({ lieOnce: false }));

vi.mock("../../src/storage/event-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/storage/event-store.js")>();
  return {
    ...actual,
    hasGenesisEvent: (projectId: string) => {
      if (schedule.lieOnce) {
        schedule.lieOnce = false;
        return false;
      }
      return actual.hasGenesisEvent(projectId);
    },
  };
});

type FakeEvent = ObservedToolCall;

let sandbox: string;
const projectId = "proj_genesis_race_test";

function kernelFor(
  onCaptureError?: (error: unknown) => void,
): SqliteMemoryKernel<string, FakeEvent> {
  return new SqliteMemoryKernel<string, FakeEvent>({
    projectId,
    actor: "mori",
    project: { title: "genesis race", rootPath: sandbox },
    observeEvent: (event) => event,
    ...(onCaptureError ? { onCaptureError } : {}),
  });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-genesis-race-"));
  process.env.MEMORIZE_ROOT = sandbox;
  schedule.lieOnce = false;
});

afterEach(async () => {
  closeAll();
  schedule.lieOnce = false;
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe("genesis bootstrap race — the loser recovers instead of crashing", () => {
  it("keeps the loser's capture flowing and leaves exactly one project.created", async () => {
    // Winner bootstraps for real first.
    const winner = kernelFor();
    winner.observe(observedShell({ toolName: "bash", command: 'git commit -m "winner"' }));
    await winner.drain();

    // The loser's `hasGenesisEvent` is lied to ONCE — as if its check had run
    // before the winner's append, the real shape of the race.
    schedule.lieOnce = true;
    const loserErrors: unknown[] = [];
    const loser = kernelFor((error) => loserErrors.push(error));
    loser.observe(observedShell({ toolName: "bash", command: 'git commit -m "loser"' }));
    await loser.drain();

    // The loser must not have reported a capture failure — losing the genesis
    // race is the database rejecting an insert that was always going to be a
    // no-op, not a bootstrap error.
    expect(loserErrors).toEqual([]);

    const events = await readEvents(projectId);
    expect(events.filter((event) => event.type === "project.created")).toHaveLength(1);

    // The loser's own capture still landed — losing the race did not stop it
    // from doing its actual work afterward.
    const summaries = listRecentObservations(projectId, { limit: 10 })
      .map((observation) => observation.summary ?? "")
      .join("\n");
    expect(summaries).toContain("winner");
    expect(summaries).toContain("loser");
  });
});

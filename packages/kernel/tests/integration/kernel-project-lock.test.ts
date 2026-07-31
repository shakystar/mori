/**
 * #132 — the project-scoped lock, exercised through the kernel seam.
 *
 * Every case here builds TWO `SqliteMemoryKernel` instances over the SAME
 * `projectId`. That is the in-test stand-in for two `mori` processes opened on
 * one working root: separate `enqueue` chains, separate genesis memos, separate
 * `WeakMap` identities — every object-scoped serialization device the kernel had
 * before the lock is defeated by it, exactly as a second process defeats them.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ConsolidatorLlm } from "../../src/index.js";
import {
  observedShell,
  SqliteMemoryKernel,
  type ObservedToolCall,
} from "../../src/kernel/sqlite-memory-kernel.js";
import { listRecentObservations, listValidMemories } from "../../src/services/projection-store.js";
import { closeAll } from "../../src/storage/db.js";
import { readEvents } from "../../src/storage/event-store.js";
import { getProjectLockDir } from "../../src/storage/project-lock.js";

type FakeEvent = ObservedToolCall;

let sandbox: string;
const projectId = "proj_kernel_lock_test";

function kernelFor(
  options: Partial<ConstructorParameters<typeof SqliteMemoryKernel>[0]> = {},
): SqliteMemoryKernel<string, FakeEvent> {
  return new SqliteMemoryKernel<string, FakeEvent>({
    projectId,
    actor: "mori",
    project: { title: "kernel lock", rootPath: sandbox },
    observeEvent: (event) => event,
    ...options,
  });
}

/**
 * An extractor that yields one memory per boundary, so duplicates are countable.
 *
 * `latencyMs` is what makes the boundary race observable: the watermark read and
 * the `memory.consolidated` append sit on either side of this call, so a second
 * boundary entering while the first is still extracting reads the un-advanced
 * watermark and distills the same window again. An instant extractor closes that
 * window by accident and hides the bug.
 */
function countingLlm(latencyMs = 0): { llm: ConsolidatorLlm; calls: number } {
  const state = { calls: 0 };
  return {
    get calls(): number {
      return state.calls;
    },
    llm: {
      async complete(): Promise<string> {
        state.calls += 1;
        if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
        return JSON.stringify([
          { kind: "decision", text: "프로젝트 스코프 락을 쓴다", salience: 7 },
        ]);
      },
    },
  };
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-kernel-lock-"));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe("two kernels over one store — capture", () => {
  it("keeps BOTH observations in the projection, not just the event log (PR #127 P1)", async () => {
    // Genesis first, so this case isolates the capture race from the bootstrap one.
    const seed = kernelFor();
    seed.observe(observedShell({ toolName: "bash", command: 'git commit -m "seed"' }));
    await seed.drain();

    const a = kernelFor();
    const b = kernelFor();
    a.observe(observedShell({ toolName: "bash", command: 'git commit -m "from-a"' }));
    b.observe(observedShell({ toolName: "bash", command: 'git commit -m "from-b"' }));
    await Promise.all([a.drain(), b.drain()]);

    const events = await readEvents(projectId);
    const logged = events.filter((event) => event.type === "observation.captured");
    expect(logged).toHaveLength(3);

    // The bug this guards: `captureObservation` rebuilds the projection by
    // REPLACING it from a log snapshot read before the append. Interleaved
    // without the lock, the later replace-all commits a snapshot that predates
    // the other kernel's append — the observation stays above but vanishes here.
    const projected = listRecentObservations(projectId, { limit: 10 });
    expect(projected).toHaveLength(logged.length);
    const summaries = projected.map((observation) => observation.summary ?? "").join("\n");
    expect(summaries).toContain("from-a");
    expect(summaries).toContain("from-b");
  });

  /**
   * A guard, not a reproduction — and deliberately so. `ensureGenesis`'s
   * `hasGenesisEvent` check and its `appendEvent` have no await between them
   * (better-sqlite3 is synchronous, so `appendEvent`'s async signature never
   * yields), which makes check-then-append atomic WITHIN one event loop. The
   * duplicate genesis PR #127 describes therefore needs two real processes to
   * observe, and no in-process arrangement of these two kernels can produce it.
   * What this test does pin down is that putting `ensureGenesis` inside the lock
   * did not break bootstrap — the regression the fix could plausibly cause.
   */
  it("mints exactly one project.created when both kernels bootstrap at once", async () => {
    const a = kernelFor();
    const b = kernelFor();

    a.observe(observedShell({ toolName: "bash", command: 'git commit -m "a"' }));
    b.observe(observedShell({ toolName: "bash", command: 'git commit -m "b"' }));
    await Promise.all([a.drain(), b.drain()]);

    const types = (await readEvents(projectId)).map((event) => event.type);
    expect(types.filter((type) => type === "project.created")).toHaveLength(1);
    expect(types.filter((type) => type === "observation.captured")).toHaveLength(2);
  });

  it("reports an unusable lock through onCaptureError instead of throwing into the loop", async () => {
    // A plain file where the lock directory belongs: the lock can never be
    // taken, and `observe`'s no-throw contract has to survive that.
    await mkdir(join(sandbox, "projects", projectId), { recursive: true });
    await writeFile(getProjectLockDir(projectId), "not a lock");

    const errors: unknown[] = [];
    const kernel = kernelFor({ onCaptureError: (error) => errors.push(error) });

    expect(() =>
      kernel.observe(observedShell({ toolName: "bash", command: 'git commit -m "wip"' })),
    ).not.toThrow();
    await expect(kernel.drain()).resolves.toBeUndefined();

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toMatch(/not a directory/);
  });
});

describe("two kernels over one store — consolidation boundary", () => {
  it("distills the window once; the loser sees the advanced watermark and noops (PR #130 P1)", async () => {
    const seed = kernelFor();
    seed.observe(observedShell({ toolName: "bash", command: "결정: 락을 넣는다" }));
    seed.observe(observedShell({ toolName: "bash", command: 'git commit -m "lock"' }));
    await seed.drain();

    const counter = countingLlm(150);
    const a = kernelFor();
    const b = kernelFor();

    const results = await Promise.all([
      a.consolidateWithResult(counter.llm),
      b.consolidateWithResult(counter.llm),
    ]);

    const outcomes = results.map((result) => result.outcome).sort();
    expect(outcomes).toEqual(["noop", "ok"]);
    expect(counter.calls).toBe(1);

    const consolidated = (await readEvents(projectId)).filter(
      (event) => event.type === "memory.consolidated",
    );
    expect(consolidated).toHaveLength(1);
    expect(listValidMemories(projectId).map((row) => row.memory.text)).toEqual([
      "프로젝트 스코프 락을 쓴다",
    ]);
  });

  it("does not deadlock on its own queued captures (drain runs outside the lock)", async () => {
    const { llm } = countingLlm();
    const kernel = kernelFor();

    // Undrained: `consolidateWithResult` must drain these — and those queued
    // captures take the very lock the boundary is about to take. Draining from
    // inside the lock would make this call wait on itself.
    kernel.observe(observedShell({ toolName: "bash", command: "결정: 락을 넣는다" }));

    const result = await kernel.consolidateWithResult(llm);

    expect(result.observationsProcessed).toBe(1);
    expect(result.outcome).toBe("ok");
  });
});

/**
 * #158 — what the critical sections do with the signal `withProjectLock` hands
 * them, and precisely what is on disk when they stop.
 *
 * Every case here runs the REAL composition: a real lock, taken away for real
 * mid-section, a real heartbeat noticing, and the real service running inside.
 * The only concession to a test is `heartbeatMs`, turned down from 5s so a case
 * takes milliseconds — the mechanism it drives is untouched.
 *
 * `withProjectLock(projectId, (signal) => service({ …, signal }))` is not a
 * stand-in for the kernel seam, it IS that seam: `observe` and
 * `consolidateWithResult` are that expression plus `ensureGenesis`, and
 * `consolidateWithResult` returns the lock's promise directly — so what a
 * caller of the kernel sees on a cancelled BOUNDARY is exactly what these cases
 * assert. Capture is the exception, because `observe` puts `enqueue` and
 * `onCaptureError` between the section and its caller; that one contract gets
 * its own case through the kernel itself, at the price of a real heartbeat.
 *
 * The claim under test is narrow and it is the whole issue: stopping is only an
 * improvement if it stops where nothing is half-committed. So each case asserts
 * BOTH sides — what did not happen, and what did.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createObservation, createProject } from "../../src/domain/entities.js";
import type { ConsolidatorLlm, ConversationSlice, ConversationSource } from "../../src/index.js";
import {
  observedShell,
  SqliteMemoryKernel,
  type ObservedToolCall,
} from "../../src/kernel/sqlite-memory-kernel.js";
import { captureObservation } from "../../src/services/capture-service.js";
import {
  consolidate,
  getConsolidateWatermark,
  type ConsolidateResult,
} from "../../src/services/consolidate-service.js";
import {
  listRecentObservations,
  listValidMemories,
  rebuildProjectProjection,
} from "../../src/services/projection-store.js";
import { listSegments } from "../../src/services/segment-store.js";
import { closeAll } from "../../src/storage/db.js";
import { appendEvent, readEvents } from "../../src/storage/event-store.js";
import {
  getProjectLockDir,
  ProjectLockCompromisedError,
  withProjectLock,
} from "../../src/storage/project-lock.js";

/**
 * When armed, the next `appendEvent` of the given type runs for real and THEN
 * runs `after` — the one way to land a takeover in the gap between a service's
 * append and the commit that follows it, which is the gap check point ② exists
 * to close.
 */
const hook = vi.hoisted(() => ({
  onType: undefined as string | undefined,
  after: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("../../src/storage/event-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/storage/event-store.js")>();
  return {
    ...actual,
    appendEvent: async (input: { type: string }) => {
      const event = await actual.appendEvent(input as Parameters<typeof actual.appendEvent>[0]);
      if (hook.onType === input.type && hook.after) {
        const after = hook.after;
        hook.onType = undefined;
        hook.after = undefined;
        await after();
      }
      return event;
    },
  };
});

let sandbox: string;
let projectId: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-coop-cancel-"));
  process.env.MEMORIZE_ROOT = sandbox;
  hook.onType = undefined;
  hook.after = undefined;

  const project = createProject({
    title: "cooperative cancellation",
    rootPath: join(sandbox, "p"),
  });
  projectId = project.id;
  await appendEvent({
    type: "project.created",
    projectId,
    scopeType: "project",
    scopeId: projectId,
    actor: "test",
    payload: project,
  });
});

afterEach(async () => {
  closeAll();
  hook.onType = undefined;
  hook.after = undefined;
  delete process.env.MEMORIZE_ROOT;
  delete process.env.MEMORIZE_RAW_SEGMENTS;
  await rm(sandbox, { recursive: true, force: true });
});

/** Take this project's lock away the way a mistimed reclaim does (#132 ⑥). */
async function stealLock(): Promise<void> {
  const lockDir = getProjectLockDir(projectId);
  await rm(lockDir, { recursive: true, force: true });
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    join(lockDir, "owner.json"),
    JSON.stringify({
      token: "foreign-token",
      pid: 0x7fffffff,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
    }),
  );
}

/** Steal the lock and wait for the holder's heartbeat to notice — then return. */
async function stealAndLetTheHeartbeatNotice(signal: AbortSignal): Promise<void> {
  await stealLock();
  const deadline = Date.now() + 2_000;
  while (!signal.aborted) {
    if (Date.now() > deadline) throw new Error("the heartbeat never noticed the takeover");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const LOCK_OPTS = { heartbeatMs: 10 } as const;

async function capturedEvents(): Promise<unknown[]> {
  return (await readEvents(projectId)).filter((event) => event.type === "observation.captured");
}

async function consolidatedEvents(): Promise<unknown[]> {
  return (await readEvents(projectId)).filter((event) => event.type === "memory.consolidated");
}

// --- capture ------------------------------------------------------------------

describe("capture — stopping before the projection replace-all", () => {
  it("commits nothing at all when the lock is already gone before the append", async () => {
    // Check point ①. The section had not written a byte, so neither does the store.
    const controller = new AbortController();
    controller.abort(new ProjectLockCompromisedError(projectId));

    await expect(
      captureObservation({
        projectId,
        actor: "test",
        toolName: "Bash",
        toolInputText: 'git commit -m "dispossessed"',
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ProjectLockCompromisedError);

    expect(await capturedEvents()).toHaveLength(0);
    expect(listRecentObservations(projectId, { limit: 10 })).toHaveLength(0);
  });

  it("leaves the observation in the event log and the projection untouched when the lock goes mid-capture", async () => {
    // Check point ②, exercised at the only moment that matters: AFTER the
    // append, BEFORE the replace-all. What survives is the asymmetry the check
    // point is designed around — the log is append-only and authoritative, the
    // projection is derived and rebuilt wholesale, so an observation appended
    // without a rebuild is deferred, not lost.
    //
    // Seed one observation first, so "the projection did not move" is a
    // statement about a projection that has something in it — an empty one
    // would pass this test for the wrong reason.
    await captureObservation({
      projectId,
      actor: "test",
      toolName: "Bash",
      toolInputText: 'git commit -m "seed"',
    });
    expect(listRecentObservations(projectId, { limit: 10 })).toHaveLength(1);

    hook.onType = "observation.captured";
    hook.after = undefined;

    await expect(
      withProjectLock(
        projectId,
        async (signal) => {
          hook.after = () => stealAndLetTheHeartbeatNotice(signal);
          return captureObservation({
            projectId,
            actor: "test",
            toolName: "Bash",
            toolInputText: 'git commit -m "dispossessed"',
            signal,
          });
        },
        LOCK_OPTS,
      ),
    ).rejects.toBeInstanceOf(ProjectLockCompromisedError);

    // Appended — and deliberately not rewound. History is append-only.
    expect(await capturedEvents()).toHaveLength(2);

    // Not projected: the replace-all never ran. Running it would have committed
    // a snapshot read before we knew the store was someone else's, which is the
    // read-modify-write #132 removed.
    const projected = listRecentObservations(projectId, { limit: 10 });
    expect(projected).toHaveLength(1);
    expect(projected[0]?.summary).toContain("seed");

    // …and the deferral really is a deferral: the next rebuild picks it up.
    await rebuildProjectProjection(projectId, { reindexSearch: false });
    expect(listRecentObservations(projectId, { limit: 10 })).toHaveLength(2);
  });

  it("is unchanged when no cancellation happens", async () => {
    const observed = await withProjectLock(
      projectId,
      (signal) =>
        captureObservation({
          projectId,
          actor: "test",
          toolName: "Bash",
          toolInputText: 'git commit -m "healthy"',
          signal,
        }),
      LOCK_OPTS,
    );

    expect(observed).toBeDefined();
    expect(await capturedEvents()).toHaveLength(1);
    expect(listRecentObservations(projectId, { limit: 10 })).toHaveLength(1);
  });
});

describe("capture — what the kernel's caller is told", () => {
  /**
   * The one contract that lives ABOVE `withProjectLock` and so cannot be
   * asserted from the composition the rest of this file uses: `observe` is
   * synchronous and must never throw, so an aborted capture has to arrive as
   * exactly ONE `onCaptureError` — the same cost as a lock that could not be
   * taken at all (`kernel-project-lock.test.ts`), not a dead turn and not a
   * silent success. #132 fixed that price; #158 must not change it.
   *
   * Deliberately SLOW: this case runs the kernel seam, which takes the lock
   * with production defaults, so there is no `heartbeatMs` to turn down and the
   * takeover is only noticed on a real 5s beat. Waiting is the point — turning
   * the knob would mean not testing the seam.
   */
  it("reports an aborted capture to onCaptureError exactly once", { timeout: 60_000 }, async () => {
    const errors: unknown[] = [];
    const kernel = new SqliteMemoryKernel<string, ObservedToolCall>({
      projectId,
      actor: "mori",
      project: { title: "cooperative cancellation", rootPath: join(sandbox, "p") },
      observeEvent: (event) => event,
      onCaptureError: (error) => errors.push(error),
    });

    // Steal the lock right after the observation lands in the log, then hold
    // the section open past one real heartbeat so the holder finds out before
    // it reaches the projection rebuild.
    hook.onType = "observation.captured";
    hook.after = async () => {
      await stealLock();
      await new Promise((resolve) => setTimeout(resolve, 7_000));
    };

    expect(() =>
      kernel.observe(observedShell({ toolName: "bash", command: 'git commit -m "dispossessed"' })),
    ).not.toThrow();
    await expect(kernel.drain()).resolves.toBeUndefined();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ProjectLockCompromisedError);

    // …and the price really was one observation, not a corrupted projection.
    expect(await capturedEvents()).toHaveLength(1);
    expect(listRecentObservations(projectId, { limit: 10 })).toHaveLength(0);
  });
});

// --- boundary -----------------------------------------------------------------

/**
 * An extractor that takes the lock away the moment it is called, then waits for
 * the heartbeat before answering. That is the shape the issue is about: the
 * extraction call is the long pole of a boundary (minutes, against a real LLM),
 * so it is where a takeover lands and where the old behaviour meant the
 * dispossessed holder kept working the whole time.
 *
 * `honourSignal` picks which half of the plumbing a case drives — an extractor
 * that ignores its signal and returns normally (the rule-based one, a provider
 * without abort support) versus one that lets the request be cancelled, the
 * seam #167 opened and #158 rides.
 */
function dispossessingLlm(opts: { honourSignal: boolean }): ConsolidatorLlm & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls(): number {
      return state.calls;
    },
    async complete(_prompt: string, callOpts?: { signal?: AbortSignal }): Promise<string> {
      state.calls += 1;
      const signal = callOpts?.signal;
      if (!signal) throw new Error("expected the boundary to forward a signal");
      await stealAndLetTheHeartbeatNotice(signal);
      if (opts.honourSignal) {
        // What a fetch-based provider does when its signal fires.
        const aborted = new Error("The operation was aborted");
        aborted.name = "AbortError";
        throw aborted;
      }
      return JSON.stringify([{ kind: "decision", text: "must not be recorded", salience: 7 }]);
    },
  };
}

async function seedObservation(summary: string): Promise<void> {
  await appendEvent({
    type: "observation.captured",
    projectId,
    scopeType: "session",
    scopeId: projectId,
    actor: "test",
    payload: createObservation({
      projectId,
      signal: "decision-keyword",
      summary,
      toolName: "Bash",
    }),
  });
}

function fakeConversation(text: string): ConversationSource & { offsets: number[] } {
  const offsets: number[] = [];
  return {
    id: "conv-cancel",
    offsets,
    async read(offset: number): Promise<ConversationSlice | undefined> {
      offsets.push(offset);
      if (offset >= text.length) return undefined;
      // No resume points: these cases never want a PARTIAL consumption muddying
      // "the cursor did not move" — the slice is shown whole or held whole.
      return { text: text.slice(offset), newOffset: text.length, resumePoints: [] };
    },
  };
}

describe("boundary — stopping before the memory.consolidated append", () => {
  it("appends no memory, writes no segment and leaves both cursors where it found them", async () => {
    await seedObservation("결정: 협조적 취소를 넣는다");
    const conversation = fakeConversation(
      "사용자: 취소를 어디서 확인하나\n\n에이전트: 커밋 직전\n\n",
    );
    const llm = dispossessingLlm({ honourSignal: false });

    const watermarkBefore = getConsolidateWatermark(projectId);

    await expect(
      withProjectLock(
        projectId,
        (lockSignal) => consolidate({ projectId, actor: "test", llm, conversation, lockSignal }),
        LOCK_OPTS,
      ),
    ).rejects.toBeInstanceOf(ProjectLockCompromisedError);

    // The extractor DID run — this is a boundary stopped after extraction, which
    // is the expensive case and the one where "stop before committing" has to
    // hold on its own rather than by never getting started.
    expect(llm.calls).toBe(1);

    // Nothing distilled: no event, and therefore nothing in the projection.
    expect(await consolidatedEvents()).toHaveLength(0);
    expect(listValidMemories(projectId)).toHaveLength(0);

    // Nothing in the derived buffer either: check point ③ sits before the
    // segment write precisely so a takeover during extraction does not leave
    // chunks for the next boundary to duplicate and prune.
    expect(listSegments(projectId)).toHaveLength(0);

    // Neither cursor moved. `commitBoundaryCursors` is the last thing `run()`
    // does, so stopping before the append leaves the whole window unconsumed.
    expect(getConsolidateWatermark(projectId)).toBe(watermarkBefore);

    // …which is the property that matters: the next boundary sees the same
    // window, from the same conversation offset, and distills it exactly once.
    const recovered = await consolidate({
      projectId,
      actor: "test",
      llm: {
        async complete(): Promise<string> {
          return JSON.stringify([
            { kind: "decision", text: "재시도가 같은 창을 처리한다", salience: 7 },
          ]);
        },
      },
      conversation,
    });
    expect(recovered.outcome).toBe("ok");
    expect(recovered.observationsProcessed).toBe(1);
    expect(conversation.offsets).toEqual([0, 0]);
    expect(listValidMemories(projectId).map((row) => row.memory.text)).toEqual([
      "재시도가 같은 창을 처리한다",
    ]);
  });

  it("cancels the in-flight extraction and still reports the lock's verdict, not the transport's", async () => {
    // The unification the issue asks for. A provider whose request is aborted
    // rejects with a bare `AbortError`, which names the mechanism and not the
    // reason; a caller must not have to guess whether that meant "the user
    // pressed Ctrl-C" or "this store stopped being yours".
    await seedObservation("결정: 추출 중 락을 잃는다");
    const llm = dispossessingLlm({ honourSignal: true });

    const failure = await withProjectLock(
      projectId,
      (lockSignal) => consolidate({ projectId, actor: "test", llm, lockSignal }),
      LOCK_OPTS,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProjectLockCompromisedError);
    expect((failure as Error).message).toContain(projectId);
    expect(await consolidatedEvents()).toHaveLength(0);
    expect(getConsolidateWatermark(projectId)).toBeUndefined();
  });

  it("stops before the watermark-only commit of an otherwise empty boundary", async () => {
    // The noop path writes one cursor and nothing else. Small, but still a
    // commit against a store that is no longer ours, so it gets a check point
    // too — and the caller still learns the span was unguarded rather than
    // being told "noop, nothing to do".
    await seedObservation("이미 소비된 창");
    await consolidate({
      projectId,
      actor: "test",
      llm: {
        async complete(): Promise<string> {
          return JSON.stringify([{ kind: "progress", text: "첫 경계", salience: 4 }]);
        },
      },
    });
    const watermarkAfterFirst = getConsolidateWatermark(projectId);
    expect(watermarkAfterFirst).toBeDefined();

    // A second window with only a foreign-shaped leftover: nothing to extract,
    // so `run()` reaches the noop commit — where the lock is already gone.
    await seedObservation("두 번째 관측");
    await consolidate({ projectId, actor: "test" });
    await seedObservation("세 번째 관측");

    const watermarkBefore = getConsolidateWatermark(projectId);

    await expect(
      withProjectLock(
        projectId,
        async (lockSignal) => {
          await stealAndLetTheHeartbeatNotice(lockSignal);
          return consolidate({ projectId, actor: "test", lockSignal });
        },
        LOCK_OPTS,
      ),
    ).rejects.toBeInstanceOf(ProjectLockCompromisedError);

    expect(getConsolidateWatermark(projectId)).toBe(watermarkBefore);
  });

  it("is unchanged when no cancellation happens", async () => {
    await seedObservation("결정: 정상 경계");
    const conversation = fakeConversation("사용자: 정상\n\n에이전트: 정상\n\n");

    const result: ConsolidateResult = await withProjectLock(
      projectId,
      (lockSignal) =>
        consolidate({
          projectId,
          actor: "test",
          conversation,
          lockSignal,
          llm: {
            async complete(): Promise<string> {
              return JSON.stringify([
                { kind: "decision", text: "정상적으로 기록된다", salience: 6 },
              ]);
            },
          },
        }),
      LOCK_OPTS,
    );

    expect(result.outcome).toBe("ok");
    expect(result.consolidated).toBe(1);
    expect(await consolidatedEvents()).toHaveLength(1);
    expect(getConsolidateWatermark(projectId)).toBeDefined();
    expect(listSegments(projectId).length).toBeGreaterThan(0);
  });
});

/**
 * #211 — the TAIL of a consolidation boundary: everything after check point ④.
 *
 * #158 gave `consolidate()` four cooperative check points, the last of them
 * immediately before the `memory.consolidated` append. Past that append there
 * can be no fifth: `throwIfDispossessed`'s contract is that nothing the section
 * meant to commit may already be on disk, and by then the memories ARE on disk.
 * So the tail — a projection rebuild, two embedder round trips, an LLM
 * contradiction judge, then the cursor commit and the attempt telemetry — runs
 * to the end even for a boundary that has already been dispossessed. That is
 * most of a boundary's wall-clock, and it holds two writes:
 *
 * - `commitBoundaryCursors`, which used to move both cursors unconditionally,
 *   so a loser waking up late could pull the watermark (or the conversation
 *   offset) BACK behind the winner's and hand the same window to a third
 *   boundary (PR #210 Codex P1);
 * - `recordAttempt`, which used to write `last_consolidate_attempt` into the
 *   shared project db after this process stopped owning it, so the loser's
 *   verdict could overwrite the winner's (PR #210 Codex P2).
 *
 * Both are closed here without a fifth check point: the cursor commit is made
 * MONOTONIC, and the telemetry write is skipped once this holder's lock is
 * gone. These cases drive the real composition — a real lock, taken away for
 * real inside the tail, a real heartbeat noticing — because the interleave is
 * the claim.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createObservation, createProject } from "../../src/domain/entities.js";
import type { ConversationSlice, ConversationSource, Embedder } from "../../src/index.js";
import {
  consolidate,
  getConsolidateWatermark,
  readLastConsolidateAttempt,
  type ConsolidateAttempt,
  type Consolidator,
  type ExtractedMemory,
} from "../../src/services/consolidate-service.js";
import { closeAll } from "../../src/storage/db.js";
import { appendEvent, readEvents } from "../../src/storage/event-store.js";
import {
  getProjectLockDir,
  ProjectLockCompromisedError,
  withProjectLock,
} from "../../src/storage/project-lock.js";

let sandbox: string;
let projectId: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-dispossessed-tail-"));
  process.env.MEMORIZE_ROOT = sandbox;

  const project = createProject({ title: "dispossessed tail", rootPath: join(sandbox, "p") });
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
  delete process.env.MEMORIZE_ROOT;
  delete process.env.MEMORIZE_RAW_SEGMENTS;
  await rm(sandbox, { recursive: true, force: true });
});

const LOCK_OPTS = { heartbeatMs: 10 } as const;

/** Take this project's lock away the way a mistimed reclaim does (#132 ⑥). */
async function stealLock(): Promise<void> {
  const lockDir = getProjectLockDir(projectId);
  await rm(lockDir, { recursive: true, force: true });
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    join(lockDir, "owner.json"),
    JSON.stringify({
      token: "foreign-token",
      // Above every platform's pid_max, so it is never a running process.
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

/** Event ids of every `observation.captured`, in `seq` order — the watermark vocabulary. */
async function observationEventIds(): Promise<string[]> {
  return (await readEvents(projectId))
    .filter((event) => event.type === "observation.captured")
    .map((event) => event.id);
}

/**
 * An extractor that always yields one memory. Injected as `consolidator` rather
 * than `llm` on purpose: `makeLlmJudge(undefined)` then never contradicts, so
 * the tail's `detectContradictions` cannot call back into a test double while
 * the interleave under test is in flight.
 */
function yielding(text: string): Consolidator {
  return {
    async extract(): Promise<ExtractedMemory[]> {
      return [{ kind: "decision", text, salience: 7 }];
    },
  };
}

/** An extractor whose `extract()` always rejects — a failure with no lock in it. */
function failingWith(error: unknown): Consolidator {
  return {
    async extract(): Promise<ExtractedMemory[]> {
      throw error;
    },
  };
}

/**
 * An embedder that runs `onFirstCall` before answering. `ensureEmbeddings` is
 * the first await in the tail AFTER the `memory.consolidated` append, which is
 * exactly where T2–T4 of the issue's interleave belong: the loser is past its
 * last check point and has already committed its memories, and the winner does
 * a whole boundary while it waits.
 */
function embedderThatYieldsOnce(onFirstCall: () => Promise<void>): Embedder {
  let fired = false;
  return {
    model: "test-embedder",
    async embed(texts: string[]): Promise<number[][]> {
      if (!fired) {
        fired = true;
        await onFirstCall();
      }
      return texts.map(() => [1, 0, 0]);
    },
  };
}

/**
 * A conversation whose text GROWS between reads — the axis of the interleave
 * for the second cursor. `offsets` records every offset the kernel asked from,
 * which is how a rolled-back cursor becomes visible from outside the service.
 */
function growingConversation(initial: string): ConversationSource & {
  offsets: number[];
  append(more: string): void;
} {
  const state = { text: initial };
  const offsets: number[] = [];
  return {
    id: "conv-tail",
    offsets,
    append(more: string): void {
      state.text += more;
    },
    async read(offset: number): Promise<ConversationSlice | undefined> {
      offsets.push(offset);
      if (offset >= state.text.length) return undefined;
      // No resume points: this file is never about partial consumption.
      return { text: state.text.slice(offset), newOffset: state.text.length, resumePoints: [] };
    },
  };
}

// --- ① the cursors ------------------------------------------------------------

describe("boundary tail — a dispossessed boundary's late cursor commit", () => {
  it("cannot roll the event watermark back behind the new owner's", async () => {
    // T1: A's window is this one observation, and A gets all the way past check
    // point ④ — its `memory.consolidated` is on disk before anything goes wrong.
    await seedObservation("A의 창: 첫 관측");

    let ownerAttempt: ConsolidateAttempt | undefined;
    let watermarkAfterNewOwner: string | undefined;

    const loser = withProjectLock(
      projectId,
      (lockSignal) =>
        consolidate({
          projectId,
          actor: "loser",
          boundary: "session-end",
          consolidator: yielding("진 경계가 증류한 것"),
          lockSignal,
          embedder: embedderThatYieldsOnce(async () => {
            // T2: the lock turns over while A sits in its tail.
            await stealAndLetTheHeartbeatNotice(lockSignal);

            // T3: B reads the cursor — A has not committed, so it is still where
            // A found it — and processes a window that reaches FURTHER, because
            // observations kept arriving while A was busy.
            await seedObservation("B의 창: 새 관측");

            // T4: B commits. From here on the store's watermark is B's.
            const owner = await consolidate({
              projectId,
              actor: "new-owner",
              boundary: "threshold",
              consolidator: yielding("새 주인이 증류한 것"),
            });
            expect(owner.outcome).toBe("ok");
            watermarkAfterNewOwner = getConsolidateWatermark(projectId);
            ownerAttempt = readLastConsolidateAttempt(projectId);
          }),
        }),
      LOCK_OPTS,
    );

    // T5: A wakes up, finishes its tail and commits — and `withProjectLock`
    // reports the span as unguarded, which it always did.
    await expect(loser).rejects.toBeInstanceOf(ProjectLockCompromisedError);

    const [firstObservation, secondObservation] = await observationEventIds();
    expect(watermarkAfterNewOwner).toBe(secondObservation);

    // T6, and the whole point: the watermark did NOT go back to A's window.
    // Before #211 it did, and the next boundary re-read (A.end, B.end] — the
    // duplicate distillation #132 set out to remove.
    expect(getConsolidateWatermark(projectId)).toBe(secondObservation);
    expect(getConsolidateWatermark(projectId)).not.toBe(firstObservation);

    // ② from the same interleave: A ran to the END of its tail, so it reaches
    // the success-path `recordAttempt` too. The winner's record must survive.
    expect(readLastConsolidateAttempt(projectId)).toEqual(ownerAttempt);
    expect(readLastConsolidateAttempt(projectId)?.boundary).toBe("threshold");
  });

  it("cannot roll the conversation offset back behind the new owner's", async () => {
    // Same interleave on the OTHER cursor. `commitBoundaryCursors` writes both
    // in one transaction, so both need the guard or the pair is only half safe.
    const conversation = growingConversation("사용자: 첫 질문\n\n에이전트: 첫 답\n\n");
    const initialLength = "사용자: 첫 질문\n\n에이전트: 첫 답\n\n".length;

    const loser = withProjectLock(
      projectId,
      (lockSignal) =>
        consolidate({
          projectId,
          actor: "loser",
          consolidator: yielding("진 경계의 대화 증류"),
          conversation,
          lockSignal,
          embedder: embedderThatYieldsOnce(async () => {
            await stealAndLetTheHeartbeatNotice(lockSignal);
            conversation.append("사용자: 그 뒤에 더 말했다\n\n에이전트: 더 답했다\n\n");
            const owner = await consolidate({
              projectId,
              actor: "new-owner",
              consolidator: yielding("새 주인의 대화 증류"),
              conversation,
            });
            expect(owner.outcome).toBe("ok");
          }),
        }),
      LOCK_OPTS,
    );

    await expect(loser).rejects.toBeInstanceOf(ProjectLockCompromisedError);

    const grownLength = conversation.offsets.length;
    expect(grownLength).toBe(2);
    // Both A and B started from 0 — B could not see A's uncommitted cursor.
    expect(conversation.offsets).toEqual([0, 0]);

    // The next boundary resumes from where the WINNER left off. Before #211 the
    // loser's late commit pulled this back to its own, shorter `newOffset` and
    // the winner's tail of the conversation was extracted a second time.
    await consolidate({
      projectId,
      actor: "next",
      consolidator: yielding("다음 경계"),
      conversation,
    });
    const resumedFrom = conversation.offsets[2];
    expect(resumedFrom).toBeGreaterThan(initialLength);
  });

  it("advances both cursors exactly as before when nothing is taken away", async () => {
    // The non-regression side of ①: an unmolested boundary's cursor advance is
    // untouched, including the #139 property that the two cursors move together.
    const conversation = growingConversation("사용자: 정상\n\n에이전트: 정상\n\n");
    await seedObservation("정상 경계의 관측");

    const first = await withProjectLock(
      projectId,
      (lockSignal) =>
        consolidate({
          projectId,
          actor: "healthy",
          consolidator: yielding("정상적으로 기록된다"),
          conversation,
          lockSignal,
        }),
      LOCK_OPTS,
    );
    expect(first.outcome).toBe("ok");

    const [firstObservation] = await observationEventIds();
    expect(getConsolidateWatermark(projectId)).toBe(firstObservation);

    // A second boundary over strictly newer material moves BOTH cursors on.
    await seedObservation("두 번째 관측");
    conversation.append("사용자: 더\n\n에이전트: 더\n\n");
    const second = await withProjectLock(
      projectId,
      (lockSignal) =>
        consolidate({
          projectId,
          actor: "healthy",
          consolidator: yielding("두 번째도 기록된다"),
          conversation,
          lockSignal,
        }),
      LOCK_OPTS,
    );
    expect(second.outcome).toBe("ok");

    const [, secondObservation] = await observationEventIds();
    expect(getConsolidateWatermark(projectId)).toBe(secondObservation);
    // Read at 0, then from the first slice's end: the offset advanced too.
    expect(conversation.offsets[0]).toBe(0);
    expect(conversation.offsets[1]).toBeGreaterThan(0);
  });
});

// --- ② the attempt telemetry --------------------------------------------------

describe("boundary tail — attempt telemetry after dispossession", () => {
  it("leaves the new owner's record alone when the loser fails from the takeover", async () => {
    // The `catch` half of ②: the loser stops at check point ④ and its failure
    // record used to land in the shared db, overwriting the `ok` the winner had
    // just written. Damage is observability, not safety — `mori status` says a
    // boundary failed when the boundary that actually owns the store succeeded.
    await seedObservation("정상 경계");
    await consolidate({
      projectId,
      actor: "owner",
      boundary: "threshold",
      consolidator: yielding("정상 기록"),
    });
    const ownerAttempt = readLastConsolidateAttempt(projectId);
    expect(ownerAttempt?.outcome).toBe("ok");

    await seedObservation("빼앗기는 경계");
    await expect(
      withProjectLock(
        projectId,
        async (lockSignal) => {
          await stealAndLetTheHeartbeatNotice(lockSignal);
          return consolidate({
            projectId,
            actor: "loser",
            boundary: "session-end",
            consolidator: yielding("기록되면 안 되는 것"),
            lockSignal,
          });
        },
        LOCK_OPTS,
      ),
    ).rejects.toBeInstanceOf(ProjectLockCompromisedError);

    expect(readLastConsolidateAttempt(projectId)).toEqual(ownerAttempt);
  });

  it("still records a failure that has nothing to do with the lock", async () => {
    // The other half, and the one that keeps ② from becoming telemetry silence:
    // a boundary holding a healthy lock records every outcome exactly as before.
    await seedObservation("타임아웃 나는 경계");

    await expect(
      withProjectLock(
        projectId,
        (lockSignal) =>
          consolidate({
            projectId,
            actor: "healthy",
            boundary: "session-end",
            consolidator: failingWith(new Error("extractor timed out after 20000ms")),
            lockSignal,
          }),
        LOCK_OPTS,
      ),
    ).rejects.toThrow("timed out");

    const attempt = readLastConsolidateAttempt(projectId);
    expect(attempt?.outcome).toBe("timeout");
    expect(attempt?.boundary).toBe("session-end");
    expect(attempt?.error).toContain("timed out");
  });

  it("still records a healthy boundary's success", async () => {
    await seedObservation("성공하는 경계");

    const result = await withProjectLock(
      projectId,
      (lockSignal) =>
        consolidate({
          projectId,
          actor: "healthy",
          boundary: "manual",
          consolidator: yielding("성공"),
          lockSignal,
        }),
      LOCK_OPTS,
    );

    expect(result.outcome).toBe("ok");
    const attempt = readLastConsolidateAttempt(projectId);
    expect(attempt?.outcome).toBe("ok");
    expect(attempt?.consolidated).toBe(1);
  });
});

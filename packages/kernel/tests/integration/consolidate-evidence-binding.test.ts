import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createConsolidatedMemory,
  createObservation,
  createProject,
} from "../../src/domain/entities.js";
import { consolidate, getConsolidateWatermark } from "../../src/services/consolidate-service.js";
import { listValidMemories } from "../../src/services/projection-store.js";
import { closeAll } from "../../src/storage/db.js";
import { appendEvent, readEvents } from "../../src/storage/event-store.js";

/**
 * Why one call is mocked here (TESTING.md "예외: 타이밍 레이스·장애 주입").
 *
 * The second test asserts a NEGATIVE: that #298's cost gate exits a quiet
 * boundary WITHOUT replaying the log. Both paths return the same `noop` result
 * and write the same cursor, so the replay leaves no observable trace to assert
 * on — and the alternative, timing the two paths, is exactly the performance
 * measurement the issue forbids leaving in CI (#296 §Q3 is a document, not a
 * test). Arming `readEvents` to fail turns "did not replay" into observable
 * final state: with the gate the boundary still completes and still advances
 * its cursor; without it the same call rejects.
 *
 * The seam is partial and explicit — everything reaches the real event-store
 * through `importOriginal`, only a call made while the flag is armed behaves
 * differently (the fixture's own reads, and the first test's, run for real),
 * and the assertions are observable final state: the boundary's outcome, the
 * stored watermark, and what is in the log. The mock's own call log is never
 * asserted on.
 */
const readEventsSeam = vi.hoisted(() => ({ fail: false }));

vi.mock("../../src/storage/event-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/storage/event-store.js")>();
  return {
    ...actual,
    readEvents: async (projectId: string) => {
      if (readEventsSeam.fail) {
        throw new Error("readEvents must not be called on the cost-gate path");
      }
      return actual.readEvents(projectId);
    },
  };
});

let sandbox: string;
let projectId: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-consolidate-evidence-"));
  process.env.MEMORIZE_ROOT = sandbox;

  const project = createProject({ title: "evidence binding", rootPath: join(sandbox, "p") });
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
  readEventsSeam.fail = false;
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

/** A self-lane `observation.captured`; returns the OBSERVATION id (what a
 *  memory's `sourceObservationIds` names). */
async function seedObservation(summary: string): Promise<string> {
  const observation = createObservation({
    projectId,
    signal: "decision-keyword",
    summary,
    toolName: "Bash",
  });
  await appendEvent({
    type: "observation.captured",
    projectId,
    scopeType: "session",
    scopeId: projectId,
    actor: "test",
    payload: observation,
  });
  return observation.id;
}

/** An `observation.captured` carried in by a workspace union sibling (#113
 *  item②) — same db, foreign lane. */
async function seedForeignObservation(summary: string): Promise<void> {
  const observation = createObservation({
    projectId,
    signal: "decision-keyword",
    summary,
    toolName: "Bash",
  });
  await appendEvent({
    type: "observation.captured",
    projectId,
    scopeType: "session",
    scopeId: projectId,
    actor: "test",
    sourceProjectId: "proj_evidence_foreign_sibling",
    payload: observation,
  });
}

describe("consolidateBoundary evidence binding (#298, #189 ㉱)", () => {
  // The interleave #296 §Q5.3 describes: a competing holder's
  // `memory.consolidated` has ALREADY landed on the log, but its rebuild has
  // not committed — so the `memories` projection is still pre-takeover. The
  // CAS on `expectedHead` passes (the log has not moved since this boundary
  // read it) while the projection-derived evidence is stale, and this boundary
  // redistills what the other holder just consolidated.
  it("does not redistill observations a landed append already consumed while the opponent's rebuild is still pending", async () => {
    const first = await seedObservation("decided to drop the cache");
    const second = await seedObservation("decided to keep the index");

    const opponentMemory = createConsolidatedMemory({
      projectId,
      kind: "decision",
      text: "the opponent's distillation of this same window",
      salience: 6,
      sourceObservationIds: [first, second],
    });
    await appendEvent({
      type: "memory.consolidated",
      projectId,
      scopeType: "session",
      scopeId: projectId,
      actor: "opponent",
      payload: opponentMemory,
    });

    // The premise, asserted rather than assumed: the append is on the log, the
    // projection has not caught up, and the opponent's `commitBoundaryCursors`
    // (the very last step of its run) has not moved the watermark either.
    expect(listValidMemories(projectId)).toHaveLength(0);
    expect(getConsolidateWatermark(projectId)).toBeUndefined();

    const result = await consolidate({ projectId, actor: "test" });

    // Every self-lane observation in the window is consumed by the landed
    // append, so this boundary has nothing of its own left to distill.
    expect(result).toMatchObject({ outcome: "noop", consolidated: 0 });
    const consolidated = (await readEvents(projectId)).filter(
      (event) => event.type === "memory.consolidated",
    );
    expect(consolidated).toHaveLength(1);
    expect(consolidated[0]!.payload).toMatchObject({ id: opponentMemory.id });
  });

  // #296 §Q6 acceptance criterion 3: binding the evidence to the log costs a
  // full replay, and a boundary that would do nothing anyway must not pay it.
  it("takes the noop exit without replaying the log when the window holds no self-lane observation and no conversation content", async () => {
    await seedForeignObservation("a union sibling's observation");
    const head = (await readEvents(projectId)).at(-1)!.id;

    readEventsSeam.fail = true;
    const result = await consolidate({ projectId, actor: "test" });
    readEventsSeam.fail = false;

    expect(result).toMatchObject({ outcome: "noop", observationsProcessed: 0 });
    // And the gate path still does the cursor advance the post-replay noop
    // does, so a foreign-only window is not rescanned on every boundary.
    expect(getConsolidateWatermark(projectId)).toBe(head);
  });

  // PR #299 owner review: the same shape on the CONVERSATION axis. The slice is
  // evidence too — it becomes segments and extraction input — but it cannot be
  // derived from the log, so the only thing that can cover it is being read
  // AFTER `expectedHead` is stamped. Read before the stamp, an opponent's
  // `memory.consolidated` landing in between passes the CAS while this boundary
  // re-distills a slice the opponent already consumed, and nothing downstream
  // absorbs that: segment ids are minted rather than content-derived, and the
  // offset cursor is monotone (it refuses a rewind, not a repeat).
  it("does not redistill a conversation slice when the opponent's append lands after this boundary read that slice", async () => {
    // The head as of before the opponent appends — what this boundary must
    // stamp if it reads the log before it reads the conversation.
    const headBeforeOpponent = (await readEvents(projectId)).at(-1)!.id;
    const text = "USER: should we ship the cursor rewrite?\n\nAGENT: yes, behind the flag";
    const opponentMemory = createConsolidatedMemory({
      projectId,
      kind: "decision",
      text: "ship the cursor rewrite behind the flag",
      salience: 6,
      sourceObservationIds: [],
    });

    // The interleave, driven by the source itself: the opponent's append lands
    // between this boundary's slice read and its log read. A `ConversationSource`
    // is harness code the kernel calls into, which makes it the honest seam for
    // "something else happened while we were reading the conversation" — no
    // kernel module is stubbed here.
    const offsets: number[] = [];
    let opponentLanded = false;
    const conversation = {
      id: "conv-race",
      async read(offset: number) {
        offsets.push(offset);
        if (!opponentLanded) {
          opponentLanded = true;
          await appendEvent({
            type: "memory.consolidated",
            projectId,
            scopeType: "session",
            scopeId: projectId,
            actor: "opponent",
            payload: opponentMemory,
          });
        }
        return { text, newOffset: text.length, resumePoints: [] };
      },
    };

    const boundary = consolidate({
      projectId,
      actor: "test",
      conversation,
      consolidator: {
        async extract(input) {
          return input.transcriptTail
            ? [{ kind: "decision" as const, text: "ship it behind the flag", salience: 6 }]
            : [];
        },
      },
    });

    // Refused by the CAS, and the two heads say exactly WHY: this boundary
    // stamped the head it saw before reading the conversation, and the log had
    // moved on to the opponent's append by the time it tried to write. Asserting
    // both ends rules out the ways this could pass for the wrong reason — an
    // unrelated throw, or a head that came back empty and refused everything.
    await expect(boundary).rejects.toMatchObject({
      name: "StaleHeadError",
      expectedHead: headBeforeOpponent,
      actualHead: (await readEvents(projectId)).at(-1)!.id,
    });

    // The premises, asserted rather than assumed: the opponent's append really
    // did land, and this boundary really did read the slice from offset 0 — the
    // opponent commits its own offset at the very end of its run, so the cursor
    // still points at conversation the opponent has already consumed.
    expect(opponentLanded).toBe(true);
    expect(offsets).toEqual([0]);

    // The distillation of that conversation exists exactly once.
    const consolidated = (await readEvents(projectId)).filter(
      (event) => event.type === "memory.consolidated",
    );
    expect(consolidated).toHaveLength(1);
    expect(consolidated[0]!.payload).toMatchObject({ id: opponentMemory.id });
  });
});

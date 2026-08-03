import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION } from "../../src/domain/common.js";
import { createConflict, createObservation, createProject } from "../../src/domain/entities.js";
import type { ConflictStatus } from "../../src/domain/entities/conflict.js";
import { DEFAULT_ACCOUNT_ID } from "../../src/domain/identity/account.js";
import { getPersonalStoreId } from "../../src/domain/identity/personal-store.js";
import type { ConversationSlice, ConversationSource } from "../../src/index.js";
import { resolveConflict } from "../../src/services/conflict-service.js";
import { SEGMENT_MAX_CHARS, consolidate } from "../../src/services/consolidate-service.js";
import {
  getMemoryIndex,
  listOpenConflicts,
  listRecentObservations,
  rebuildProjectProjection,
} from "../../src/services/projection-store.js";
import { searchByKind } from "../../src/services/search-service.js";
import { listSegments, pruneSegments } from "../../src/services/segment-store.js";
import { closeAll } from "../../src/storage/db.js";
import { appendEvent } from "../../src/storage/event-store.js";
import { getProjectDbFile } from "../../src/storage/path-resolver.js";

/**
 * ONE defect class, three instances: **two code paths answer the same question
 * and disagree.** #148 (`getMemoryIndex().openConflicts` vs
 * `listOpenConflicts()`), #116 (the `segments` body vs the `search_fts` index),
 * and #155 (path resolution vs self-identity for a personal-store id) were all
 * reported separately and all fixed separately, but none of them was something a
 * reviewer should have been expected to spot by eye — each is a filter or a
 * normalization present on one path and absent on the other.
 *
 * This file exists to make that class a CI gate instead of a review finding
 * (#207, part A of #188). Every test here asserts the SHAPE
 * `answerOfPathA === answerOfPathB` over a store built from an event log, not a
 * fixed expected value: a future change that re-introduces the asymmetry fails
 * here even if it invents a new status, a new prune trigger, or a new store id.
 *
 * Rules the tests follow, so they keep their value:
 *
 * - The store state comes from appended events / real service entry points, and
 *   both answers are read back through the production readers. Neither side is
 *   recomputed with the helper the implementation uses, which would make the
 *   assertion a tautology (PR #168's CPT lesson).
 * - Each test carries a non-vacuity anchor, because "both paths return
 *   everything" and "both paths return nothing" also satisfy equality.
 */

let sandbox: string;
let rawSegmentsBefore: string | undefined;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-two-reader-"));
  process.env.MEMORIZE_ROOT = sandbox;
  // The #116 pair only exists while the raw-detail buffer writes segments, and
  // `MEMORIZE_RAW_SEGMENTS=0` is a supported setting, not a misconfiguration.
  // Pin the mode here (the repo's other raw-segment tests neutralize the same
  // variable) so an inherited environment cannot turn this gate red *before*
  // the equivalence it exists to check ever runs.
  rawSegmentsBefore = process.env.MEMORIZE_RAW_SEGMENTS;
  process.env.MEMORIZE_RAW_SEGMENTS = "1";
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  if (rawSegmentsBefore === undefined) delete process.env.MEMORIZE_RAW_SEGMENTS;
  else process.env.MEMORIZE_RAW_SEGMENTS = rawSegmentsBefore;
  await rm(sandbox, { recursive: true, force: true });
});

async function seedProject(): Promise<string> {
  const project = createProject({ title: "two-reader", rootPath: join(sandbox, "p") });
  await appendEvent({
    type: "project.created",
    projectId: project.id,
    scopeType: "project",
    scopeId: project.id,
    actor: "test",
    payload: project,
  });
  return project.id;
}

// --- #148: which conflicts are open? -----------------------------------------

/**
 * The independent oracle for "is a conflict in this status open?". Deliberately
 * spelled out here instead of derived from `TERMINAL_CONFLICT_STATUSES` — that
 * constant is what BOTH readers already filter with, so reusing it would only
 * compare an implementation against itself. Typed as a total `Record` over
 * `ConflictStatus`, so adding a status to the domain breaks `typecheck:test`
 * until someone states whether the new status is open.
 */
const CONFLICT_IS_OPEN: Record<ConflictStatus, boolean> = {
  detected: true,
  // `escalated -> resolved` still exists, so escalated is not terminal.
  escalated: true,
  resolved: false,
  auto_resolved: false,
};

async function seedConflictInStatus(projectId: string, status: ConflictStatus): Promise<string> {
  const conflict = createConflict({
    projectId,
    scopeType: "rule",
    scopeId: projectId,
    fieldPath: `field_${status}`,
    leftVersion: "left",
    rightVersion: "right",
    conflictType: "rule",
  });
  await appendEvent({
    type: "conflict.detected",
    projectId,
    scopeType: "project",
    // scopeId = the conflict's own id; the reducer keys state.conflicts by it.
    scopeId: conflict.id,
    actor: "test",
    payload: conflict,
  });
  await rebuildProjectProjection(projectId);
  if (status !== "detected") {
    await resolveConflict({ projectId, conflictId: conflict.id, status, actor: "test" });
  }
  return conflict.id;
}

describe("two-reader equivalence: open conflicts (#148)", () => {
  /**
   * What must equal what: the id set `getMemoryIndex().openConflicts` carries
   * (the persisted startup index, built in projector.ts) and the id set
   * `listOpenConflicts()` returns (the SQL reader in projection-store.ts). Both
   * name themselves "open conflicts"; a status filter that lands on only one of
   * them is exactly #148.
   */
  it("getMemoryIndex().openConflicts and listOpenConflicts() report the same ids for every conflict status", async () => {
    const projectId = await seedProject();

    const statuses = Object.keys(CONFLICT_IS_OPEN) as ConflictStatus[];
    const idByStatus = new Map<ConflictStatus, string>();
    for (const status of statuses) {
      idByStatus.set(status, await seedConflictInStatus(projectId, status));
    }

    const indexOpenIds = (getMemoryIndex(projectId)?.openConflicts ?? []).map((c) => c.id).sort();
    const readerOpenIds = listOpenConflicts(projectId)
      .map((c) => c.id)
      .sort();

    expect(indexOpenIds).toEqual(readerOpenIds);

    // Non-vacuity: the agreed set is the oracle's set, so "both readers return
    // everything" (the pre-#148 state of the index) does not satisfy this.
    const expectedOpenIds = statuses
      .filter((status) => CONFLICT_IS_OPEN[status])
      .map((status) => idByStatus.get(status) as string)
      .sort();
    expect(indexOpenIds).toEqual(expectedOpenIds);
  });
});

// --- #116: which segments does this store hold? ------------------------------

/** Token every generated turn repeats, so one FTS query reaches every segment. */
const SEGMENT_TOKEN = "unobtaniumsegment";

/**
 * Turn length, derived from the exported chunking budget rather than hardcoded.
 * `chunkConversation` packs whole turns greedily, so it can never fit two turns
 * in one segment once `len + 2 + len > SEGMENT_MAX_CHARS` — i.e. once a turn is
 * over half the budget. 60% keeps that true if someone legitimately retunes the
 * constant, so "one turn = one segment" stops being an assumption about 1500.
 */
const TURN_CHARS = Math.ceil(SEGMENT_MAX_CHARS * 0.6);

/** One turn: an ordinal plus repeats of the token, padded past `TURN_CHARS`. */
function fakeTurn(ordinal: number): string {
  const prefix = `turn ${ordinal} `;
  const filler = `${SEGMENT_TOKEN} `;
  const repeats = Math.ceil((TURN_CHARS - prefix.length) / filler.length);
  return `${prefix}${filler.repeat(repeats)}`.trimEnd();
}

/**
 * A conversation of `turns` turns, each over half of `SEGMENT_MAX_CHARS`, so
 * greedy turn-packing gives one segment per turn with a distinct ordinal inside
 * a single boundary's shared `created_at`.
 */
function fakeConversation(turns: number): ConversationSource {
  const text = Array.from({ length: turns }, (_, i) => fakeTurn(i)).join("\n\n");
  let read = false;
  return {
    id: "conv-1",
    async read(): Promise<ConversationSlice | undefined> {
      if (read) return undefined;
      read = true;
      return { text, newOffset: text.length, resumePoints: [] };
    },
  };
}

describe("two-reader equivalence: stored segments vs the search index (#116)", () => {
  /**
   * What must equal what: the segment ids `listSegments()` returns (the
   * `segments` table — the body of the raw-transcript buffer) and the segment
   * ids `searchByKind(..., "segment")` returns (the `search_fts` index, which
   * holds its OWN copy of the text). `pruneSegments` deleting from one and not
   * the other is #116; the equality also fails the other way, if a prune ever
   * evicted the index rows of segments that survived.
   */
  it("listSegments() and searchByKind(segment) report the same ids after a standalone prune", async () => {
    const projectId = await seedProject();

    // Real write path: a consolidation boundary chunks the slice into segments
    // and reindexes FTS itself, so both sides start out populated by production
    // code rather than by the test.
    await consolidate({
      projectId,
      actor: "test",
      conversation: fakeConversation(5),
      consolidator: {
        async extract() {
          return [{ kind: "progress", text: "noted", salience: 5 }];
        },
      },
    });
    expect(listSegments(projectId)).toHaveLength(5);

    // Standalone prune — the maintenance/manual entry point. consolidate()
    // happens to reindex right after its own prune, which is why this defect
    // stayed invisible in production; pruneSegments is exported and must keep
    // the two readers consistent on its own.
    const pruned = pruneSegments(projectId, { maxCount: 3 });
    expect(pruned).toHaveLength(2);

    const bodyIds = listSegments(projectId)
      .map((s) => s.id)
      .sort();
    const indexIds = searchByKind(projectId, SEGMENT_TOKEN, "segment", 50)
      .map((hit) => hit.entityId)
      .sort();

    expect(indexIds).toEqual(bodyIds);
    // Non-vacuity: survivors are still reachable through BOTH readers, so
    // "prune wiped everything" does not satisfy the equality either.
    expect(bodyIds).toHaveLength(3);
  });
});

// --- #155: does this store id denote the same store as that one? -------------

const DEFAULT_PERSONAL_ID = getPersonalStoreId(DEFAULT_ACCOUNT_ID); // legacy "personal_self"
const OTHER_PERSONAL_ID = getPersonalStoreId("acc_abc"); // "personal_acc_abc"
const PERSONAL_TS = "2026-06-01T00:00:00.000Z";

async function seedPersonalStore(personalStoreId: string, summary: string): Promise<void> {
  await appendEvent({
    type: "project.created",
    projectId: personalStoreId,
    scopeType: "project",
    scopeId: personalStoreId,
    actor: "test",
    payload: {
      id: personalStoreId,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: PERSONAL_TS,
      updatedAt: PERSONAL_TS,
      title: "Personal",
      summary: "personal store",
      goals: [],
      status: "active",
      rootPath: "/tmp/personal",
      activeWorkstreamIds: [],
      activeTaskIds: [],
      acceptedDecisionIds: [],
      ruleIds: [],
    } as never,
  });
  await appendEvent({
    type: "observation.captured",
    projectId: personalStoreId,
    scopeType: "session",
    scopeId: personalStoreId,
    actor: "test",
    payload: createObservation({
      projectId: personalStoreId,
      signal: "decision-keyword",
      summary,
    }),
  });
  await rebuildProjectProjection(personalStoreId);
}

describe("two-reader equivalence: personal-store identity vs path routing (#155)", () => {
  /**
   * What must equal what: "do ids X and Y denote the same store?" answered by
   * path resolution (`getProjectDbFile(X) === getProjectDbFile(Y)`) and answered
   * by self-identity (does the store opened as Y count an observation written
   * under X as its OWN — i.e. does it survive in Y's self lane?). #155 was the
   * two disagreeing: two personal-store ids routed to one db while every reader
   * still anchored self on the id it was opened with, so one account's own
   * observations read back as foreign and vanished from the self lane.
   */
  it("path routing and self-identity agree on whether two personal-store ids are the same store", async () => {
    // Guard against a false-green: the cross pairs below only mean anything
    // while the two ids are actually distinct. If `getPersonalStoreId` ever
    // collapsed them, `notes` would hold one key and the loop would degenerate
    // to the writer === reader case, which passes trivially.
    expect(OTHER_PERSONAL_ID).not.toBe(DEFAULT_PERSONAL_ID);

    const notes = {
      [DEFAULT_PERSONAL_ID]: "default account self note",
      [OTHER_PERSONAL_ID]: "other account self note",
    };
    // Written in this order, so under an aliasing path resolver the LAST
    // rebuild anchors self on OTHER_PERSONAL_ID and demotes the other id's
    // observation to the foreign lane.
    await seedPersonalStore(DEFAULT_PERSONAL_ID, notes[DEFAULT_PERSONAL_ID] as string);
    await seedPersonalStore(OTHER_PERSONAL_ID, notes[OTHER_PERSONAL_ID] as string);

    const ids = [DEFAULT_PERSONAL_ID, OTHER_PERSONAL_ID];
    for (const writer of ids) {
      for (const reader of ids) {
        const sameStoreByPath = getProjectDbFile(writer) === getProjectDbFile(reader);
        const sameStoreByIdentity = listRecentObservations(reader, { limit: 10 }).some(
          (observation) => observation.summary === notes[writer],
        );
        expect({ writer, reader, same: sameStoreByIdentity }).toEqual({
          writer,
          reader,
          same: sameStoreByPath,
        });
      }
    }
    // Non-vacuity: the loop above includes writer === reader, where both
    // answers must be `true` — a store that lost its own observation from the
    // self lane fails there, not just on the cross pairs.
  });
});

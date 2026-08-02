import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION } from "../../src/domain/common.js";
import { createObservation } from "../../src/domain/entities.js";
import { DEFAULT_ACCOUNT_ID } from "../../src/domain/identity/account.js";
import { getPersonalStoreId } from "../../src/domain/identity/personal-store.js";
import {
  listRecentObservations,
  rebuildProjectProjection,
} from "../../src/services/projection-store.js";
import { closeAll, getDb } from "../../src/storage/db.js";
import { appendEvent } from "../../src/storage/event-store.js";
import { getProjectDbFile } from "../../src/storage/path-resolver.js";

// #155: two accounts' personal-store ids (`getPersonalStoreId`) used to alias
// the SAME on-disk db (path-resolver routed every `personal_*` id to one
// shared `personal/` dir). Opening account B's personal store under its own
// id then anchored self-comparison on B's id while every self-authored row
// was still tagged with A's id (or vice versa) — a self observation read
// back as foreign and dropped from the self-lane tail. The fix makes each
// account's personal store its own physical db (`getPersonalRoot`, #155), so
// there is no longer an alias to mis-anchor: opening a personal-store id
// always reaches a db whose only genesis is that same id.

const SELF_ID = getPersonalStoreId(DEFAULT_ACCOUNT_ID); // legacy "personal_self"
const OTHER_ID = getPersonalStoreId("acc_abc"); // "personal_acc_abc"
const ts = "2026-06-01T00:00:00.000Z";

let sandbox: string;

function genesisPayload(id: string) {
  return {
    id,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    title: "Personal",
    summary: "personal store",
    goals: [],
    status: "active",
    rootPath: "/tmp/personal",
    activeWorkstreamIds: [],
    activeTaskIds: [],
    acceptedDecisionIds: [],
    ruleIds: [],
  };
}

async function seedPersonalStore(projectId: string, summary: string): Promise<void> {
  await appendEvent({
    type: "project.created",
    projectId,
    scopeType: "project",
    scopeId: projectId,
    actor: "test",
    payload: genesisPayload(projectId) as never,
  });
  await appendEvent({
    type: "observation.captured",
    projectId,
    scopeType: "session",
    scopeId: projectId,
    actor: "test",
    payload: createObservation({ projectId, signal: "decision-keyword", summary }),
  });
  await rebuildProjectProjection(projectId);
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-personal-isolation-"));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe("personal-store id family isolation (#155)", () => {
  it("routes distinct accounts' personal-store ids to distinct db files", () => {
    expect(getProjectDbFile(SELF_ID)).not.toBe(getProjectDbFile(OTHER_ID));
  });

  it("a self-authored observation stays in the self lane after opening + rebuilding under its OWN account id", async () => {
    await seedPersonalStore(SELF_ID, "default account self note");
    await seedPersonalStore(OTHER_ID, "other account self note");

    // Each store's self-lane tail contains only ITS OWN observation — never
    // the other account's, and never mislabelled as foreign within its own db.
    expect(listRecentObservations(SELF_ID, { limit: 10 }).map((o) => o.summary)).toEqual([
      "default account self note",
    ]);
    expect(listRecentObservations(OTHER_ID, { limit: 10 }).map((o) => o.summary)).toEqual([
      "other account self note",
    ]);
  });

  it("the write path (rebuildProjectProjection) does not cross-contaminate either account's lane", async () => {
    await seedPersonalStore(SELF_ID, "s1");
    await seedPersonalStore(OTHER_ID, "o1");

    // Re-run the write path again for both — simulating a later session
    // re-opening + rebuilding each store — and confirm the lane still holds.
    await rebuildProjectProjection(SELF_ID);
    await rebuildProjectProjection(OTHER_ID);

    const selfRows = getDb(SELF_ID)
      .prepare("SELECT source_project_id AS lane FROM observations")
      .all() as Array<{ lane: string | null }>;
    const otherRows = getDb(OTHER_ID)
      .prepare("SELECT source_project_id AS lane FROM observations")
      .all() as Array<{ lane: string | null }>;

    expect(selfRows).toEqual([{ lane: null }]);
    expect(otherRows).toEqual([{ lane: null }]);
  });
});

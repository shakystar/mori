import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProject } from "../../src/domain/entities.js";
import { upsertEmbedding, getEmbedding } from "../../src/services/embeddings-store.js";
import { rebuildProjectProjection } from "../../src/services/projection-store.js";
import { searchByKind } from "../../src/services/search-service.js";
import {
  insertSegments,
  listSegments,
  listSegmentTexts,
  pruneSegments,
  SEGMENT_RETENTION_DAYS,
  SEGMENT_RETENTION_MAX,
  type NewSegmentRow,
} from "../../src/services/segment-store.js";
import { closeAll } from "../../src/storage/db.js";
import { appendEvent } from "../../src/storage/event-store.js";

/**
 * Write-path coverage for #92 (`insertSegments`/`pruneSegments`). Read-path
 * coverage (lane scoping, search/retrieval) already lives in
 * segment-retrieval.test.ts and seeds rows by inserting into the table
 * directly; here the rows go through the real write path instead.
 */
let sandbox: string;
let projectId: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-seg-store-"));
  process.env.MEMORIZE_ROOT = sandbox;

  const project = createProject({ title: "seg-store", rootPath: "/tmp/seg-store" });
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
  await rm(sandbox, { recursive: true, force: true });
});

function row(id: string, text: string, createdAt: string, ordinal = 0): NewSegmentRow {
  return { id, text, createdAt, ordinal, sessionId: "s1" };
}

describe("insertSegments", () => {
  it("writes are readable back by listSegments/listSegmentTexts", () => {
    insertSegments(projectId, [
      row("seg_1", "alpha", "2026-01-01T00:00:00.000Z"),
      row("seg_2", "beta", "2026-01-02T00:00:00.000Z"),
    ]);

    expect(listSegments(projectId).map((s) => s.id)).toEqual(["seg_2", "seg_1"]);
    expect(listSegmentTexts(projectId).get("seg_1")).toBe("alpha");
    expect(listSegmentTexts(projectId).get("seg_2")).toBe("beta");
  });

  it("is a no-op for an empty batch", () => {
    insertSegments(projectId, []);
    expect(listSegments(projectId)).toEqual([]);
  });

  it("written rows always resolve to the self lane, never union-only (#72 no leak)", () => {
    insertSegments(projectId, [row("seg_1", "alpha", "2026-01-01T00:00:00.000Z")]);

    expect(listSegments(projectId).map((s) => s.id)).toEqual(["seg_1"]);
    expect(listSegments(projectId, "union").map((s) => s.id)).toEqual(["seg_1"]);
    expect(listSegments(projectId)[0]!.sourceProjectId).toBeUndefined();
  });

  it("INSERT OR REPLACE lets a re-insert of the same id overwrite its text", () => {
    insertSegments(projectId, [row("seg_1", "alpha", "2026-01-01T00:00:00.000Z")]);
    insertSegments(projectId, [row("seg_1", "alpha-updated", "2026-01-01T00:00:00.000Z")]);

    expect(listSegments(projectId)).toHaveLength(1);
    expect(listSegmentTexts(projectId).get("seg_1")).toBe("alpha-updated");
  });
});

describe("pruneSegments", () => {
  it("deletes segments older than maxAgeDays and keeps the rest", () => {
    const now = new Date("2026-02-01T00:00:00.000Z").getTime();
    insertSegments(projectId, [
      row("seg_old", "old", "2026-01-01T00:00:00.000Z"),
      row("seg_new", "new", "2026-01-31T00:00:00.000Z"),
    ]);

    const deleted = pruneSegments(projectId, { maxAgeDays: 10, nowMs: now });

    expect(deleted).toEqual(["seg_old"]);
    expect(listSegments(projectId).map((s) => s.id)).toEqual(["seg_new"]);
  });

  it("deletes the oldest rows beyond maxCount once age pruning has run", () => {
    const now = new Date("2026-01-10T00:00:00.000Z").getTime();
    insertSegments(projectId, [
      row("seg_1", "1", "2026-01-01T00:00:00.000Z"),
      row("seg_2", "2", "2026-01-02T00:00:00.000Z"),
      row("seg_3", "3", "2026-01-03T00:00:00.000Z"),
    ]);

    const deleted = pruneSegments(projectId, { maxAgeDays: 365, maxCount: 2, nowMs: now });

    expect(deleted).toEqual(["seg_1"]);
    expect(
      listSegments(projectId)
        .map((s) => s.id)
        .sort(),
    ).toEqual(["seg_2", "seg_3"]);
  });

  it("within one boundary (shared created_at) drops the lowest ordinals, keeping the highest (#116)", () => {
    // consolidate-service.ts assigns one createdAt per boundary and ordinals
    // 0..n-1 within it, so a cap cutting through a boundary must keep the
    // *later* (higher-ordinal) chunks and drop the *earlier* ones — dropping
    // high ordinals would delete the end of the conversation and keep a
    // truncated opening, inverting the "drop oldest" contract.
    const now = new Date("2026-01-10T00:00:00.000Z").getTime();
    const createdAt = "2026-01-05T00:00:00.000Z";
    insertSegments(projectId, [
      row("seg_0", "0", createdAt, 0),
      row("seg_1", "1", createdAt, 1),
      row("seg_2", "2", createdAt, 2),
      row("seg_3", "3", createdAt, 3),
      row("seg_4", "4", createdAt, 4),
    ]);

    const deleted = pruneSegments(projectId, { maxAgeDays: 365, maxCount: 3, nowMs: now });

    expect(deleted.sort()).toEqual(["seg_0", "seg_1"]);
    expect(
      listSegments(projectId)
        .map((s) => s.id)
        .sort(),
    ).toEqual(["seg_2", "seg_3", "seg_4"]);
  });

  it("cross-boundary priority is still newest created_at first, even with tied ordinals inside each boundary (#116)", () => {
    // Older boundary (t1) has 3 chunks, newer boundary (t2) has 2. The tied
    // ordinal-DESC rule must only break ties *within* a created_at group —
    // it must never let an older boundary's chunk outrank a newer boundary's.
    const now = new Date("2026-01-10T00:00:00.000Z").getTime();
    const t1 = "2026-01-01T00:00:00.000Z";
    const t2 = "2026-01-02T00:00:00.000Z";
    insertSegments(projectId, [
      row("t1_0", "a", t1, 0),
      row("t1_1", "b", t1, 1),
      row("t1_2", "c", t1, 2),
      row("t2_0", "d", t2, 0),
      row("t2_1", "e", t2, 1),
    ]);

    const deleted = pruneSegments(projectId, { maxAgeDays: 365, maxCount: 3, nowMs: now });

    // Both t2 rows survive in full before any t1 row is kept; the cap then
    // cuts into t1, keeping its highest ordinal (t1_2) and dropping the rest.
    expect(deleted.sort()).toEqual(["t1_0", "t1_1"]);
    expect(
      listSegments(projectId)
        .map((s) => s.id)
        .sort(),
    ).toEqual(["t1_2", "t2_0", "t2_1"]);
  });

  it("removes the matching kind='segment' embedding row for every pruned id", () => {
    const now = new Date("2026-02-01T00:00:00.000Z").getTime();
    insertSegments(projectId, [row("seg_old", "old", "2026-01-01T00:00:00.000Z")]);
    upsertEmbedding(projectId, {
      entityId: "seg_old",
      kind: "segment",
      model: "fake",
      dim: 2,
      vector: [1, 0],
      textHash: "old",
      createdAt: new Date(0).toISOString(),
    });

    pruneSegments(projectId, { maxAgeDays: 10, nowMs: now });

    expect(getEmbedding(projectId, "seg_old")).toBeUndefined();
  });

  it("removes the matching search_fts row for every pruned id, even with no reindex after (#116)", async () => {
    // Regression guard: pruneSegments must not depend on a caller reindexing
    // afterward (consolidate-service.ts happens to always do so today, but
    // pruneSegments is exported and callable standalone).
    const now = new Date("2026-02-01T00:00:00.000Z").getTime();
    insertSegments(projectId, [
      row("seg_old", "unobtaniumtoken", "2026-01-01T00:00:00.000Z"),
      row("seg_new", "new", "2026-01-31T00:00:00.000Z"),
    ]);
    // Seed search_fts the way a real boundary does (rebuild after insert),
    // so both segments are indexed before prune runs.
    await rebuildProjectProjection(projectId, { reindexSearch: true });

    pruneSegments(projectId, { maxAgeDays: 10, nowMs: now });

    const hits = searchByKind(projectId, "unobtaniumtoken", "segment");
    expect(hits).toEqual([]);
  });

  it("prunes search_fts without leaking the deleted segment's original text via snippet (#116)", async () => {
    const now = new Date("2026-02-01T00:00:00.000Z").getTime();
    insertSegments(projectId, [
      row("seg_old", "the secret payload is unobtaniumtoken", "2026-01-01T00:00:00.000Z"),
    ]);
    await rebuildProjectProjection(projectId, { reindexSearch: true });

    // Sanity: before prune, the row is actually there and would leak.
    expect(searchByKind(projectId, "unobtaniumtoken", "segment")).toHaveLength(1);

    pruneSegments(projectId, { maxAgeDays: 10, nowMs: now });

    // No hits at all post-prune — since there are zero rows, there is no
    // snippet-returning row left to leak the pruned text through.
    expect(searchByKind(projectId, "unobtaniumtoken", "segment")).toEqual([]);
  });

  it("is a no-op (returns []) when nothing qualifies for deletion", () => {
    const now = new Date("2026-01-02T00:00:00.000Z").getTime();
    insertSegments(projectId, [row("seg_1", "1", "2026-01-01T00:00:00.000Z")]);

    expect(pruneSegments(projectId, { nowMs: now })).toEqual([]);
    expect(listSegments(projectId)).toHaveLength(1);
  });

  it("defaults to SEGMENT_RETENTION_DAYS/SEGMENT_RETENTION_MAX when opts are omitted", () => {
    const now = new Date("2026-06-01T00:00:00.000Z").getTime();
    const withinRetention = new Date(now - (SEGMENT_RETENTION_DAYS - 1) * 86_400_000).toISOString();
    const pastRetention = new Date(now - (SEGMENT_RETENTION_DAYS + 1) * 86_400_000).toISOString();
    insertSegments(projectId, [
      row("seg_within", "within", withinRetention),
      row("seg_past", "past", pastRetention),
    ]);

    expect(pruneSegments(projectId, { nowMs: now })).toEqual(["seg_past"]);
    expect(SEGMENT_RETENTION_MAX).toBe(2000);
  });
});

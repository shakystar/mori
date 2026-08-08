import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION } from "../../src/domain/common.js";
import { createProject } from "../../src/domain/entities.js";
import { ageBuckets, buildInjectionYieldReport } from "../../src/services/injection-yield.js";
import { RECENCY_HALF_LIFE_DAYS } from "../../src/services/memory-retrieval-service.js";
import { rebuildProjectProjection } from "../../src/services/projection-store.js";
import { closeAll } from "../../src/storage/db.js";
import { appendEvent } from "../../src/storage/event-store.js";

/**
 * The judgement `injection-yield.ts` defines — see
 * docs/injection-yield-vocabulary.md for why re-selection is the proxy and
 * where it is wrong.
 *
 * The drop-list axis (#414, #242 조각 1/2) is NOT covered here: `fitInjectionBudget`
 * still discards silently, so the truncation facts those cases would assert on
 * do not exist in the log yet.
 */
let sandbox: string;
let projectId: string;
const NOW = "2026-06-15T00:00:00.000Z";

function isoDaysBefore(days: number): string {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-injection-yield-"));
  process.env.MEMORIZE_ROOT = sandbox;

  const project = createProject({ title: "yield", rootPath: "/tmp/yield" });
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

async function seedMemory(id: string, createdAt: string = NOW): Promise<void> {
  await appendEvent({
    type: "memory.consolidated",
    projectId,
    scopeType: "project",
    scopeId: projectId,
    actor: "test",
    payload: {
      id,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt,
      updatedAt: createdAt,
      projectId,
      kind: "insight",
      text: `memory ${id}`,
      salience: 5,
      sourceObservationIds: [],
    } as never,
  });
}

/** One injecting turn in `sessionId`, carrying `memoryIds` — the mori#214 shape. */
async function seedInjection(sessionId: string, memoryIds: string[]): Promise<void> {
  await appendEvent({
    type: "memory.injected",
    projectId,
    scopeType: "session",
    scopeId: sessionId,
    actor: "test",
    payload: { memoryIds } as never,
  });
}

describe("buildInjectionYieldReport", () => {
  it("classifies a memory re-selected by a later session as reinjected, and a once-injected one as injected-once", async () => {
    await seedMemory("mem_reused");
    await seedMemory("mem_once");
    // Session A injected both; session B only re-selected one of them. Two turns
    // inside session A so the occasion grain (sessions, not events) is what decides.
    await seedInjection("sess_a", ["mem_reused", "mem_once"]);
    await seedInjection("sess_a", ["mem_reused", "mem_once"]);
    await seedInjection("sess_b", ["mem_reused"]);
    await rebuildProjectProjection(projectId);

    const report = await buildInjectionYieldReport(projectId, { nowIso: NOW });
    expect(report.longTerm.counts).toEqual({
      reinjected: 1,
      "injected-once": 1,
      "never-injected": 0,
    });
  });

  it("classifies a memory that was never injected as never-injected, not as injected-once", async () => {
    await seedMemory("mem_injected");
    await seedMemory("mem_never");
    await seedInjection("sess_a", ["mem_injected"]);
    await rebuildProjectProjection(projectId);

    const report = await buildInjectionYieldReport(projectId, { nowIso: NOW });
    expect(report.longTerm.counts["never-injected"]).toBe(1);
    expect(report.longTerm.counts["injected-once"]).toBe(1);
  });

  it("puts two memories of different ages in different age buckets", async () => {
    await seedMemory("mem_young", isoDaysBefore(RECENCY_HALF_LIFE_DAYS * 0.5));
    await seedMemory("mem_old", isoDaysBefore(RECENCY_HALF_LIFE_DAYS * 3));
    await rebuildProjectProjection(projectId);

    const report = await buildInjectionYieldReport(projectId, { nowIso: NOW });
    const occupied = report.longTerm.byAge.filter((bucket) => bucket.counts["never-injected"] > 0);
    expect(occupied).toHaveLength(2);
    expect(occupied[0]!.label).toBe(ageBuckets()[0]!.label);
    expect(occupied[1]!.minAgeDays).toBeGreaterThan(occupied[0]!.minAgeDays);
  });
});

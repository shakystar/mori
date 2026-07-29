import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION } from "../../src/domain/common.js";
import { createProject } from "../../src/domain/entities.js";
import {
  MEMORY_POOL_BUDGET_CHARS,
  OBSERVATION_TAIL_MAX_AGE_HOURS,
  reinforceInjectedMemories,
  retrieveMemoryContext,
} from "../../src/services/memory-retrieval-service.js";
import { listValidMemories } from "../../src/services/projection-store.js";
import { rebuildProjectProjection } from "../../src/services/projection-store.js";
import { closeAll } from "../../src/storage/db.js";
import { appendEvent } from "../../src/storage/event-store.js";

/**
 * `retrieveMemoryContext`/`reinforceInjectedMemories` have no dedicated
 * upstream test — the memorize suite only exercises them indirectly via
 * cls-memory-lifecycle.test.ts, which drives capture/consolidate-service
 * (#61/#64 scope, not this slice). This is a new, minimal unit test for the
 * ranking/budget contract described in the function's own docstring.
 */
let sandbox: string;
let projectId: string;
const NOW = "2026-06-15T00:00:00.000Z";

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-mem-retrieval-"));
  process.env.MEMORIZE_ROOT = sandbox;

  const project = createProject({ title: "ret", rootPath: "/tmp/ret" });
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

function memoryPayload(id: string, text: string, salience: number, createdAt: string) {
  return {
    id,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt,
    updatedAt: createdAt,
    projectId,
    kind: "insight",
    text,
    salience,
    sourceObservationIds: [],
  };
}

async function seedMemory(
  id: string,
  text: string,
  salience: number,
  createdAt: string,
): Promise<void> {
  await appendEvent({
    type: "memory.consolidated",
    projectId,
    scopeType: "project",
    scopeId: projectId,
    actor: "test",
    payload: memoryPayload(id, text, salience, createdAt) as never,
  });
}

async function seedObservation(
  id: string,
  summary: string,
  createdAt: string,
  sourceProjectId?: string,
): Promise<void> {
  await appendEvent({
    type: "observation.captured",
    projectId,
    scopeType: "project",
    scopeId: projectId,
    actor: "test",
    ...(sourceProjectId ? { sourceProjectId } : {}),
    payload: {
      id,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt,
      updatedAt: createdAt,
      projectId,
      signal: "decision-keyword",
      summary,
    } as never,
  });
}

describe("retrieveMemoryContext", () => {
  it("ranks a high-salience recent memory above a low-salience stale one", async () => {
    await seedMemory("mem_hot", "fresh high-salience memory", 9, NOW);
    await seedMemory("mem_cold", "old low-salience memory", 1, "2020-01-01T00:00:00.000Z");
    await rebuildProjectProjection(projectId);

    const { memories } = retrieveMemoryContext(projectId, { nowIso: NOW });
    expect(memories.map((m) => m.memory.id)).toEqual(["mem_hot", "mem_cold"]);
    expect(memories[0]!.score).toBeGreaterThan(memories[1]!.score);
  });

  it("boosts a memory whose text matches the current task title", async () => {
    await seedMemory("mem_relevant", "chose zephyr as the deploy target", 3, NOW);
    await seedMemory("mem_other", "unrelated note about lunch", 3, NOW);
    await rebuildProjectProjection(projectId);

    const withTask = retrieveMemoryContext(projectId, { nowIso: NOW, taskTitle: "zephyr deploy" });
    const relevant = withTask.memories.find((m) => m.memory.id === "mem_relevant")!;
    const other = withTask.memories.find((m) => m.memory.id === "mem_other")!;
    expect(relevant.score).toBeGreaterThan(other.score);
  });

  it("truncates the pool to MEMORY_POOL_BUDGET_CHARS, dropping the lowest scorers", async () => {
    // Each memory costs text.length + 24 chars; force more candidates than
    // fit under the budget so the truncation path actually runs.
    const perMemoryChars = 400;
    const count = Math.ceil(MEMORY_POOL_BUDGET_CHARS / perMemoryChars) + 3;
    for (let i = 0; i < count; i += 1) {
      // Descending salience so id order predicts score order (i=0 is best).
      await seedMemory(`mem_${i}`, "x".repeat(perMemoryChars - 24), 10 - (i % 10), NOW);
    }
    await rebuildProjectProjection(projectId);

    const { memories } = retrieveMemoryContext(projectId, { nowIso: NOW });
    const spent = memories.reduce((sum, m) => sum + m.memory.text.length + 24, 0);
    expect(spent).toBeLessThanOrEqual(MEMORY_POOL_BUDGET_CHARS);
    expect(memories.length).toBeLessThan(count);
  });

  it("includes observations within the tail window and excludes stale ones", async () => {
    const recentIso = NOW;
    const staleIso = new Date(
      Date.parse(NOW) - (OBSERVATION_TAIL_MAX_AGE_HOURS + 1) * 3_600_000,
    ).toISOString();
    await seedObservation("obs_recent", "recent observation", recentIso);
    await seedObservation("obs_stale", "stale observation", staleIso);
    await rebuildProjectProjection(projectId);

    const { observations } = retrieveMemoryContext(projectId, { nowIso: NOW });
    expect(observations.map((o) => o.id)).toContain("obs_recent");
    expect(observations.map((o) => o.id)).not.toContain("obs_stale");
  });

  it("excludes foreign (union-lane) observations from the short-term tail by default (#74)", async () => {
    await seedObservation("obs_self", "self observation", NOW);
    await seedObservation("obs_foreign", "foreign workspace observation", NOW, "proj_lane_bob");
    await rebuildProjectProjection(projectId);

    const { observations } = retrieveMemoryContext(projectId, { nowIso: NOW });
    expect(observations.map((o) => o.id)).toContain("obs_self");
    expect(observations.map((o) => o.id)).not.toContain("obs_foreign");
  });
});

describe("reinforceInjectedMemories", () => {
  it("stamps lastAccessedAt on the injected memories only", async () => {
    await seedMemory("mem_a", "memory a", 5, NOW);
    await seedMemory("mem_b", "memory b", 5, NOW);
    await rebuildProjectProjection(projectId);

    const { memories } = retrieveMemoryContext(projectId, { nowIso: NOW });
    const injected = memories.filter((m) => m.memory.id === "mem_a");
    reinforceInjectedMemories(projectId, injected);

    const rows = new Map(listValidMemories(projectId).map((r) => [r.memory.id, r]));
    expect(rows.get("mem_a")!.lastAccessedAt).toBeDefined();
    expect(rows.get("mem_b")!.lastAccessedAt).toBeUndefined();
  });
});

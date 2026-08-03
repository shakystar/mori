import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CURRENT_SCHEMA_VERSION, nowIso } from "../../src/domain/common.js";
import { createProject } from "../../src/domain/entities.js";
import type { Embedder } from "../../src/index.js";
import { buildMemoryContext } from "../../src/services/context-service.js";
import {
  listValidMemories,
  rebuildProjectProjection,
} from "../../src/services/projection-store.js";
import { closeAll, getDb } from "../../src/storage/db.js";
import { appendEvent } from "../../src/storage/event-store.js";

/**
 * `buildMemoryContext` is the kernel-scope slice of upstream memorize's
 * `loadStartContext` (mori#63 body): the freshness/relevance-ranked memory
 * assembly only. No embedder is injected in most cases here — the
 * semantic-scoring path itself (semanticMemoryScores) already has dedicated
 * coverage in semantic-search.test.ts; this suite covers the composition
 * contract, which degrades to FTS-only exactly like upstream.
 *
 * Since #82 the embedder is a parameter, never resolved from env, so the
 * single semantic case below injects a fake `Embedder` instead of stubbing an
 * HTTP client — nothing in this file touches MEMORIZE_EMBEDDINGS_*.
 */
let sandbox: string;
let projectId: string;
const NOW = "2026-06-15T00:00:00.000Z";

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-context-svc-"));
  process.env.MEMORIZE_ROOT = sandbox;

  const project = createProject({ title: "ctx", rootPath: "/tmp/ctx" });
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
    payload: {
      id,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt,
      updatedAt: createdAt,
      projectId,
      kind: "insight",
      text,
      salience,
      sourceObservationIds: [],
    } as never,
  });
}

async function seedObservation(id: string, summary: string, createdAt: string): Promise<void> {
  await appendEvent({
    type: "observation.captured",
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
      signal: "decision-keyword",
      summary,
    } as never,
  });
}

function insertSegment(id: string, text: string, createdAt: string): void {
  getDb(projectId)
    .prepare(
      "INSERT INTO segments (id, session_id, created_at, ordinal, source, text) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, "s1", createdAt, 0, null, text);
}

describe("buildMemoryContext", () => {
  it("returns {} when the project has no memories, observations, or segments", async () => {
    await rebuildProjectProjection(projectId);
    expect(await buildMemoryContext(projectId)).toEqual({});
  });

  it("assembles consolidatedMemories ranked by the retrieval pool", async () => {
    await seedMemory("mem_hot", "chose zephyr as the deploy target", 9, NOW);
    await seedMemory("mem_cold", "old low-salience memory", 1, "2020-01-01T00:00:00.000Z");
    await rebuildProjectProjection(projectId);

    const ctx = await buildMemoryContext(projectId, { taskTitle: "zephyr deploy" });
    expect(ctx.consolidatedMemories?.map((m) => m.id)).toEqual(["mem_hot", "mem_cold"]);

    // mori#176: buildMemoryContext is retrieval-only now — it does not stamp
    // last_accessed_at itself. Reinforcement only happens once a caller (the
    // kernel) confirms the context was actually injected; see
    // kernel-context-injection.test.ts for that contract.
    const rows = new Map(listValidMemories(projectId).map((r) => [r.memory.id, r]));
    expect(rows.get("mem_hot")!.lastAccessedAt).toBeUndefined();
    expect(rows.get("mem_cold")!.lastAccessedAt).toBeUndefined();
  });

  it("includes recentObservations within the tail window", async () => {
    await seedObservation("obs_recent", "recent observation", nowIso());
    await rebuildProjectProjection(projectId);

    const ctx = await buildMemoryContext(projectId);
    expect(ctx.recentObservations?.map((o) => o.summary)).toContain("recent observation");
  });

  it("includes rawSegments matched via FTS when embeddings are unconfigured", async () => {
    insertSegment("seg_a", "the navy blazer dry cleaning pickup", "2026-01-01T00:00:00.000Z");
    await rebuildProjectProjection(projectId, { reindexSearch: true });

    const ctx = await buildMemoryContext(projectId, { taskTitle: "blazer dry cleaning" });
    expect(ctx.rawSegments?.map((s) => s.id)).toContain("seg_a");
  });

  it("omits rawSegments without a task title", async () => {
    insertSegment("seg_b", "some segment text", "2026-01-01T00:00:00.000Z");
    await rebuildProjectProjection(projectId, { reindexSearch: true });

    const ctx = await buildMemoryContext(projectId);
    expect(ctx.rawSegments).toBeUndefined();
  });

  it("embeds the task title exactly once, reusing it across the memory and segment channels", async () => {
    await seedMemory("mem_hot", "chose zephyr as the deploy target", 9, NOW);
    insertSegment("seg_a", "zephyr deploy runbook notes", "2026-01-01T00:00:00.000Z");
    await rebuildProjectProjection(projectId, { reindexSearch: true });

    const calls: string[][] = [];
    const embed = vi.fn(async (texts: string[]) => {
      calls.push(texts);
      return texts.map(() => [1, 0, 0]);
    });
    const embedder: Embedder = { embed, model: "fake-embed" };

    await buildMemoryContext(projectId, { taskTitle: "zephyr deploy", embedder });

    expect(embed).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([["zephyr deploy"]]);
  });

  it("ignores an injected embedder without a task title — nothing to embed", async () => {
    await seedMemory("mem_hot", "chose zephyr as the deploy target", 9, NOW);
    await rebuildProjectProjection(projectId, { reindexSearch: true });

    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0]));
    await buildMemoryContext(projectId, { embedder: { embed, model: "fake-embed" } });

    expect(embed).not.toHaveBeenCalled();
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConsolidatedMemory, createProject } from "../../src/domain/entities.js";
import type { ConsolidatedMemoryKind } from "../../src/domain/entities/memory.js";
import type { ConsolidatorLlm, Embedder } from "../../src/index.js";
import {
  DEFAULT_COSINE_THRESHOLD,
  SEMANTIC_CONTRADICTION_REASON_PREFIX,
  detectContradictions,
  makeLlmJudge,
  type Judge,
} from "../../src/services/contradiction-service.js";
import { ensureEmbeddings } from "../../src/services/embeddings-service.js";
import { listEmbeddings } from "../../src/services/embeddings-store.js";
import {
  listOpenConflicts,
  listValidMemories,
  rebuildProjectProjection,
} from "../../src/services/projection-store.js";
import { closeAll } from "../../src/storage/db.js";
import { appendEvent, readEvents } from "../../src/storage/event-store.js";

let sandbox: string;
let projectId: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-contradiction-svc-"));
  process.env.MEMORIZE_ROOT = sandbox;

  const project = createProject({ title: "contradiction-svc", rootPath: join(sandbox, "p") });
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

/** Deterministic embedder: exact-text -> canned vector (zero vector if unknown). */
function fakeEmbedder(vectors: Record<string, number[]>, model = "fake-embed-v1"): Embedder {
  const dim = Object.values(vectors)[0]?.length ?? 3;
  return {
    model,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => vectors[t] ?? new Array(dim).fill(0));
    },
  };
}

async function seedMemory(
  text: string,
  createdAt: string,
  kind: ConsolidatedMemoryKind = "decision",
): Promise<string> {
  const memory = {
    ...createConsolidatedMemory({
      projectId,
      kind,
      text,
      salience: 7,
      sourceObservationIds: [],
    }),
    createdAt,
    updatedAt: createdAt,
  };
  await appendEvent({
    type: "memory.consolidated",
    projectId,
    scopeType: "session",
    scopeId: projectId,
    actor: "test",
    payload: memory,
  });
  await rebuildProjectProjection(projectId);
  return memory.id;
}

const MEM_PG = "Chose PostgreSQL as the primary datastore";
const MEM_SQLITE = "Chose SQLite as the primary datastore (reversing the earlier PostgreSQL call)";
const MEM_FRONTEND = "Frontend state management uses Redux";
const VECTORS: Record<string, number[]> = {
  [MEM_PG]: [1, 0, 0],
  [MEM_SQLITE]: [0.95, 0.05, 0],
  [MEM_FRONTEND]: [0, 1, 0],
};

const alwaysContradicts: Judge = async () => ({
  contradicts: true,
  reason: "opposite datastore choice",
});
const neverContradicts: Judge = async () => ({ contradicts: false });

describe("contradiction-service", () => {
  it("no-op when no embedder is injected (mirrors ensureEmbeddings' off-by-default)", async () => {
    await seedMemory(MEM_PG, "2026-01-01T00:00:00.000Z");
    await seedMemory(MEM_SQLITE, "2026-01-02T00:00:00.000Z");
    const results = await detectContradictions({
      projectId,
      judge: alwaysContradicts,
      actor: "test",
    });
    expect(results).toEqual([]);
  });

  it("no-op with fewer than two decision memories", async () => {
    const embedder = fakeEmbedder(VECTORS);
    await seedMemory(MEM_PG, "2026-01-01T00:00:00.000Z");
    await ensureEmbeddings(projectId, embedder);
    const results = await detectContradictions({
      projectId,
      embedder,
      judge: alwaysContradicts,
      actor: "test",
    });
    expect(results).toEqual([]);
  });

  it("cosine prefilter skips the judge entirely for a dissimilar pair", async () => {
    const embedder = fakeEmbedder(VECTORS);
    await seedMemory(MEM_PG, "2026-01-01T00:00:00.000Z");
    await seedMemory(MEM_FRONTEND, "2026-01-02T00:00:00.000Z");
    await ensureEmbeddings(projectId, embedder);

    let judgeCalls = 0;
    const countingJudge: Judge = async () => {
      judgeCalls += 1;
      return { contradicts: true };
    };

    const results = await detectContradictions({
      projectId,
      embedder,
      judge: countingJudge,
      actor: "test",
    });
    expect(results).toEqual([]);
    expect(judgeCalls).toBe(0);
  });

  it("judge saying no contradiction leaves both memories valid and raises no conflict", async () => {
    const embedder = fakeEmbedder(VECTORS);
    await seedMemory(MEM_PG, "2026-01-01T00:00:00.000Z");
    await seedMemory(MEM_SQLITE, "2026-01-02T00:00:00.000Z");
    await ensureEmbeddings(projectId, embedder);

    const results = await detectContradictions({
      projectId,
      embedder,
      judge: neverContradicts,
      actor: "test",
    });
    expect(results).toEqual([]);
    expect(listValidMemories(projectId)).toHaveLength(2);
    expect(listOpenConflicts(projectId)).toHaveLength(0);
  });

  it("confirmed contradiction supersedes the older memory and raises a conflict", async () => {
    const embedder = fakeEmbedder(VECTORS);
    const olderId = await seedMemory(MEM_PG, "2026-01-01T00:00:00.000Z");
    const newerId = await seedMemory(MEM_SQLITE, "2026-01-02T00:00:00.000Z");
    await ensureEmbeddings(projectId, embedder);

    const results = await detectContradictions({
      projectId,
      embedder,
      judge: alwaysContradicts,
      actor: "test",
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.winnerId).toBe(newerId);
    expect(results[0]!.loserId).toBe(olderId);
    expect(results[0]!.reason.startsWith(SEMANTIC_CONTRADICTION_REASON_PREFIX)).toBe(true);
    expect(results[0]!.reason).toContain("opposite datastore choice");

    const validIds = listValidMemories(projectId).map((row) => row.memory.id);
    expect(validIds).toContain(newerId);
    expect(validIds).not.toContain(olderId);

    const conflicts = listOpenConflicts(projectId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.conflictType).toBe("decision");
    expect(conflicts[0]!.scopeId).toBe(newerId);
    expect([conflicts[0]!.leftVersion, conflicts[0]!.rightVersion].sort()).toEqual(
      [olderId, newerId].sort(),
    );
  });

  it("writes memory.superseded + conflict.detected back-to-back via one appendEvents batch (#118 item 3)", async () => {
    // appendEvents' own transactional rollback guarantee already has a
    // dedicated test (append-atomicity.test.ts) — asserting the failure
    // mode here again would mean mocking storage internals for no extra
    // coverage. Instead this asserts the observable consequence of routing
    // both events through ONE appendEvents call: in the seq-ordered log,
    // conflict.detected lands in the very next slot after memory.superseded,
    // with nothing else able to interleave (a two-`appendEvent` version
    // could not guarantee that adjacency).
    const embedder = fakeEmbedder(VECTORS);
    await seedMemory(MEM_PG, "2026-01-01T00:00:00.000Z");
    await seedMemory(MEM_SQLITE, "2026-01-02T00:00:00.000Z");
    await ensureEmbeddings(projectId, embedder);

    await detectContradictions({
      projectId,
      embedder,
      judge: alwaysContradicts,
      actor: "test",
    });

    const events = await readEvents(projectId);
    const supersededIdx = events.findIndex((e) => e.type === "memory.superseded");
    expect(supersededIdx).toBeGreaterThanOrEqual(0);
    expect(events[supersededIdx + 1]?.type).toBe("conflict.detected");
  });

  it("a surviving winner keeps scanning and both of its contradictions apply in one call (#118 item 4)", async () => {
    const MEM_WINNER = "Decision Z: use option A (latest call)";
    const MEM_LOSER_1 = "Decision Z: use option B instead of A";
    const MEM_LOSER_2 = "Decision Z: use option C instead of A";
    const vectors: Record<string, number[]> = {
      [MEM_WINNER]: [1, 0, 0],
      [MEM_LOSER_1]: [0.95, 0.05, 0],
      [MEM_LOSER_2]: [0.9, 0.1, 0],
    };
    const embedder = fakeEmbedder(vectors, "fake-embed-v3");
    // Seeded first (so it's `decisions[0]`, the outer-loop `a` for both
    // pairs below) but with the LATEST createdAt, so pickWinner keeps it as
    // the winner against both memories seeded after it.
    const winnerId = await seedMemory(MEM_WINNER, "2026-01-03T00:00:00.000Z");
    const loser1Id = await seedMemory(MEM_LOSER_1, "2026-01-01T00:00:00.000Z");
    const loser2Id = await seedMemory(MEM_LOSER_2, "2026-01-02T00:00:00.000Z");
    await ensureEmbeddings(projectId, embedder);

    const results = await detectContradictions({
      projectId,
      embedder,
      judge: alwaysContradicts,
      actor: "test",
    });

    // Pre-fix, the unconditional `break` stopped scanning `a` after the
    // first confirmed pair even though `a` (the winner) was still valid,
    // so only one of these two contradictions would have been applied.
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.winnerId === winnerId)).toBe(true);
    expect(results.map((r) => r.loserId).sort()).toEqual([loser1Id, loser2Id].sort());

    const validIds = listValidMemories(projectId).map((row) => row.memory.id);
    expect(validIds).toEqual([winnerId]);
    expect(listOpenConflicts(projectId)).toHaveLength(2);
  });

  it("multiple independent contradictions in one pass each persist (no scopeId collision)", async () => {
    const MEM_X1 = "Decision X: use option A";
    const MEM_X2 = "Decision X: use option B instead of A";
    const MEM_Y1 = "Decision Y: use library C";
    const MEM_Y2 = "Decision Y: use library D instead of C";
    const vectors: Record<string, number[]> = {
      [MEM_X1]: [1, 0, 0, 0],
      [MEM_X2]: [0.95, 0.05, 0, 0],
      [MEM_Y1]: [0, 0, 1, 0],
      [MEM_Y2]: [0, 0, 0.95, 0.05],
    };
    const embedder = fakeEmbedder(vectors, "fake-embed-v2");
    const x1 = await seedMemory(MEM_X1, "2026-01-01T00:00:00.000Z");
    const x2 = await seedMemory(MEM_X2, "2026-01-02T00:00:00.000Z");
    const y1 = await seedMemory(MEM_Y1, "2026-01-01T00:00:00.000Z");
    const y2 = await seedMemory(MEM_Y2, "2026-01-02T00:00:00.000Z");
    await ensureEmbeddings(projectId, embedder);

    const results = await detectContradictions({
      projectId,
      embedder,
      judge: alwaysContradicts,
      actor: "test",
    });

    expect(results).toHaveLength(2);
    expect(listOpenConflicts(projectId)).toHaveLength(2);
    const validIds = listValidMemories(projectId).map((row) => row.memory.id);
    expect(validIds.sort()).toEqual([x2, y2].sort());
    expect(validIds).not.toContain(x1);
    expect(validIds).not.toContain(y1);
  });

  it("respects a custom cosineThreshold", async () => {
    const embedder = fakeEmbedder(VECTORS);
    await seedMemory(MEM_PG, "2026-01-01T00:00:00.000Z");
    await seedMemory(MEM_SQLITE, "2026-01-02T00:00:00.000Z");
    await ensureEmbeddings(projectId, embedder);

    let judgeCalls = 0;
    const countingJudge: Judge = async () => {
      judgeCalls += 1;
      return { contradicts: false };
    };

    // cos(VECTORS[MEM_PG], VECTORS[MEM_SQLITE]) ~= 0.9987 < threshold below.
    await detectContradictions({
      projectId,
      embedder,
      judge: countingJudge,
      actor: "test",
      cosineThreshold: 0.999,
    });
    expect(judgeCalls).toBe(0);
  });

  it("never mixes embeddings from a stale model into the cosine prefilter (#118 item 1)", async () => {
    const staleEmbedder = fakeEmbedder(VECTORS, "stale-embed-v1");
    await seedMemory(MEM_PG, "2026-01-01T00:00:00.000Z");
    await seedMemory(MEM_SQLITE, "2026-01-02T00:00:00.000Z");
    // Corpus is embedded under a model the active embedder no longer is.
    await ensureEmbeddings(projectId, staleEmbedder);
    expect(listEmbeddings(projectId, "memory")).toHaveLength(2);

    const activeEmbedder = fakeEmbedder(VECTORS, "active-embed-v2");
    let judgeCalls = 0;
    const countingJudge: Judge = async () => {
      judgeCalls += 1;
      return { contradicts: true };
    };

    const results = await detectContradictions({
      projectId,
      embedder: activeEmbedder,
      judge: countingJudge,
      actor: "test",
    });

    expect(judgeCalls).toBe(0);
    expect(results).toEqual([]);
  });

  it("default threshold constant is exported and sane", () => {
    expect(DEFAULT_COSINE_THRESHOLD).toBeGreaterThan(0);
    expect(DEFAULT_COSINE_THRESHOLD).toBeLessThanOrEqual(1);
  });
});

describe("makeLlmJudge", () => {
  it("never contradicts when no llm is injected (off-by-default, never throws)", async () => {
    const judge = makeLlmJudge(undefined);
    const verdict = await judge({ a: { id: "a", text: "x" }, b: { id: "b", text: "y" } });
    expect(verdict).toEqual({ contradicts: false });
  });

  it("calls ONLY llm.complete() — no endpoint/apiKey/model resolution", async () => {
    const prompts: string[] = [];
    const llm: ConsolidatorLlm = {
      async complete(prompt: string): Promise<string> {
        prompts.push(prompt);
        return '{"contradicts": true, "reason": "directly opposite"}';
      },
    };
    const judge = makeLlmJudge(llm);
    const verdict = await judge({
      a: { id: "a", text: "Use Postgres" },
      b: { id: "b", text: "Use SQLite" },
    });
    expect(verdict).toEqual({ contradicts: true, reason: "directly opposite" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Use Postgres");
    expect(prompts[0]).toContain("Use SQLite");
  });

  it("parses a verdict wrapped in prose/markdown fencing", async () => {
    const llm: ConsolidatorLlm = {
      async complete(): Promise<string> {
        return 'Sure, here is my verdict:\n```json\n{"contradicts": false}\n```';
      },
    };
    const judge = makeLlmJudge(llm);
    const verdict = await judge({ a: { id: "a", text: "x" }, b: { id: "b", text: "y" } });
    expect(verdict.contradicts).toBe(false);
  });

  it("degrades to non-contradicting on malformed LLM output", async () => {
    const llm: ConsolidatorLlm = {
      async complete(): Promise<string> {
        return "not json at all";
      },
    };
    const judge = makeLlmJudge(llm);
    const verdict = await judge({ a: { id: "a", text: "x" }, b: { id: "b", text: "y" } });
    expect(verdict).toEqual({ contradicts: false });
  });

  it("degrades to non-contradicting when llm.complete() throws", async () => {
    const llm: ConsolidatorLlm = {
      async complete(): Promise<string> {
        throw new Error("network down");
      },
    };
    const judge = makeLlmJudge(llm);
    const verdict = await judge({ a: { id: "a", text: "x" }, b: { id: "b", text: "y" } });
    expect(verdict).toEqual({ contradicts: false });
  });
});

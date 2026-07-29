import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConsolidatedMemory, createProject } from "../../src/domain/entities.js";
import type { ConsolidatedMemoryKind } from "../../src/domain/entities/memory.js";
import {
  cosineSimilarity,
  ensureEmbeddings,
  reciprocalRankFusion,
  resolveEmbeddingsConfig,
  type Embedder,
} from "../../src/services/embeddings-service.js";
import { getEmbedding, listEmbeddings } from "../../src/services/embeddings-store.js";
import { rebuildProjectProjection } from "../../src/services/projection-store.js";
import {
  hybridSearch,
  searchProject,
  semanticScoresForKind,
  semanticSearch,
} from "../../src/services/search-service.js";
import { closeAll, getDb } from "../../src/storage/db.js";
import { appendEvent } from "../../src/storage/event-store.js";

/**
 * The upstream memorize version of this suite seeds its fixture project via
 * project-service.createProject — out-of-kernel-scope (#62 body). This uses
 * the domain `createProject` factory + appendEvent directly instead, matching
 * the pattern already established for projection-column-consistency.test.ts.
 */
let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-semantic-"));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  delete process.env.MEMORIZE_EMBEDDINGS_ENDPOINT;
  delete process.env.MEMORIZE_EMBEDDINGS_API_KEY;
  delete process.env.MEMORIZE_EMBEDDINGS_MODEL;
  await rm(sandbox, { recursive: true, force: true });
});

async function seedProject(): Promise<string> {
  const project = createProject({ title: "S", rootPath: join(sandbox, "p") });
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

/** Deterministic embedder: exact-text → canned vector (zero vector if unknown). */
function fakeEmbedder(
  vectors: Record<string, number[]>,
  model = "fake-embed-v1",
): Embedder & { calls: string[][] } {
  const dim = Object.values(vectors)[0]?.length ?? 3;
  const calls: string[][] = [];
  return {
    model,
    calls,
    async embed(texts: string[]): Promise<number[][]> {
      calls.push(texts);
      return texts.map((t) => vectors[t] ?? new Array(dim).fill(0));
    },
  };
}

async function seedMemory(
  projectId: string,
  text: string,
  kind: ConsolidatedMemoryKind = "decision",
): Promise<string> {
  const memory = createConsolidatedMemory({
    projectId,
    kind,
    text,
    salience: 7,
    sourceObservationIds: [],
  });
  await appendEvent({
    type: "memory.consolidated",
    projectId,
    scopeType: "session",
    scopeId: projectId,
    actor: "test",
    payload: memory,
  });
  return memory.id;
}

// Concept space: axis 0 = database, 1 = frontend, 2 = misc.
const MEM_A = "Chose PostgreSQL for the primary datastore";
const MEM_B = "The relational engine selection is final";
const MEM_C = "Frontend uses React hooks everywhere";
const VECTORS: Record<string, number[]> = {
  [MEM_A]: [0.9, 0, 0.1],
  [MEM_B]: [1, 0, 0],
  [MEM_C]: [0, 1, 0],
  postgresql: [1, 0, 0], // query — closest to MEM_B, no shared word with B
};

describe("semantic search (P3-c)", () => {
  it("creates the embeddings table at user_version >= 8", async () => {
    const projectId = await seedProject();
    await rebuildProjectProjection(projectId);
    const db = getDb(projectId);
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(8);
    const row = db.prepare("SELECT name FROM sqlite_master WHERE name = 'embeddings'").get() as
      { name: string } | undefined;
    expect(row?.name).toBe("embeddings");
  });

  it("ensureEmbeddings embeds valid memories and skips unchanged ones", async () => {
    const projectId = await seedProject();
    const idA = await seedMemory(projectId, MEM_A);
    await seedMemory(projectId, MEM_B);
    await rebuildProjectProjection(projectId);

    const embedder = fakeEmbedder(VECTORS);
    const first = await ensureEmbeddings(projectId, { embedder });
    expect(first.embedded).toBe(2);
    expect(listEmbeddings(projectId, "memory")).toHaveLength(2);
    expect(getEmbedding(projectId, idA)?.vector).toEqual(VECTORS[MEM_A]);

    // Second call: nothing changed → no re-embedding (text_hash + model match).
    const second = await ensureEmbeddings(projectId, { embedder });
    expect(second.embedded).toBe(0);
  });

  it("ranks memories by cosine similarity to the query", async () => {
    const projectId = await seedProject();
    const idA = await seedMemory(projectId, MEM_A);
    const idB = await seedMemory(projectId, MEM_B);
    await seedMemory(projectId, MEM_C);
    await rebuildProjectProjection(projectId);

    const embedder = fakeEmbedder(VECTORS);
    await ensureEmbeddings(projectId, { embedder });

    const hits = await semanticSearch(projectId, "postgresql", 10, embedder);
    // MEM_B (cos 1.0) and MEM_A (cos ~0.994) lead; MEM_C (cos 0) trails.
    expect(hits[0]!.entityId).toBe(idB);
    expect(hits[1]!.entityId).toBe(idA);
    expect(hits[0]!.kind).toBe("memory");
    expect(hits[0]!.snippet).toContain("relational");
  });

  it("hybridSearch fuses FTS and semantic — surfaces a semantic-only memory", async () => {
    const projectId = await seedProject();
    const idA = await seedMemory(projectId, MEM_A); // contains "PostgreSQL" → FTS hit
    const idB = await seedMemory(projectId, MEM_B); // no query word → semantic-only
    await seedMemory(projectId, MEM_C);
    await rebuildProjectProjection(projectId);

    const embedder = fakeEmbedder(VECTORS);
    await ensureEmbeddings(projectId, { embedder });

    // Pure FTS finds only MEM_A for "postgresql".
    const lexical = searchProject(projectId, "postgresql");
    expect(lexical.map((h) => h.entityId)).toEqual([idA]);

    // Hybrid surfaces MEM_B too (semantic), fused best-first.
    const hits = await hybridSearch(projectId, "postgresql", 10, embedder);
    const ids = hits.map((h) => h.entityId);
    expect(ids).toContain(idA);
    expect(ids).toContain(idB);
    // The semantic-only hit carries a snippet from the memory text.
    const bHit = hits.find((h) => h.entityId === idB)!;
    expect(bHit.snippet).toContain("relational");
  });

  it("degrades gracefully to FTS when embeddings are unconfigured", async () => {
    const projectId = await seedProject();
    const idA = await seedMemory(projectId, MEM_A);
    await seedMemory(projectId, MEM_B);
    await rebuildProjectProjection(projectId);

    // No embedder configured, no embeddings stored.
    expect((await ensureEmbeddings(projectId)).embedded).toBe(0);
    expect(await semanticSearch(projectId, "postgresql")).toEqual([]);

    const hybrid = await hybridSearch(projectId, "postgresql");
    const lexical = searchProject(projectId, "postgresql");
    expect(hybrid.map((h) => h.entityId)).toEqual(lexical.map((h) => h.entityId));
    expect(hybrid.map((h) => h.entityId)).toEqual([idA]);
  });

  it("mori#73: a corpus embedded under a stale model is excluded, semantic search falls back to lexical", async () => {
    const projectId = await seedProject();
    const idA = await seedMemory(projectId, MEM_A); // "PostgreSQL" — also an FTS hit
    await seedMemory(projectId, MEM_B);
    await rebuildProjectProjection(projectId);

    // Corpus embedded under model "old-model".
    const oldEmbedder = fakeEmbedder(VECTORS, "old-model");
    await ensureEmbeddings(projectId, { embedder: oldEmbedder });
    expect(listEmbeddings(projectId, "memory")).toHaveLength(2);

    // MEMORIZE_EMBEDDINGS_MODEL has since changed — the active embedder is a
    // different model. Corpus rows for the old model must not be treated as
    // semantic candidates against the new model's query vector.
    const newEmbedder = fakeEmbedder(VECTORS, "new-model");
    expect(await semanticSearch(projectId, "postgresql", 10, newEmbedder)).toEqual([]);

    // Falls back to lexical (FTS) results — search doesn't fail, it just
    // loses the semantic boost until ensureEmbeddings catches up.
    const lexical = searchProject(projectId, "postgresql");
    const hybrid = await hybridSearch(projectId, "postgresql", 10, newEmbedder);
    expect(hybrid.map((h) => h.entityId)).toEqual(lexical.map((h) => h.entityId));
    expect(hybrid.map((h) => h.entityId)).toEqual([idA]);

    // listEmbeddings itself filters in SQL, not JS: the model-scoped query
    // returns nothing for a model that was never stored.
    expect(listEmbeddings(projectId, "memory", "new-model")).toHaveLength(0);
    expect(listEmbeddings(projectId, "memory", "old-model")).toHaveLength(2);
  });

  it("mori#73: a same-model row with a mismatched vector length is dropped, not scored 0", async () => {
    const projectId = await seedProject();
    await seedMemory(projectId, MEM_A);
    await rebuildProjectProjection(projectId);

    // Corpus stored under model "m1" with 3-dim vectors.
    const corpusEmbedder = fakeEmbedder(VECTORS, "m1");
    await ensureEmbeddings(projectId, { embedder: corpusEmbedder });

    // Same model name, but this call's query vector is 2-dim (e.g. the
    // provider changed the output shape for that model id) — the model
    // filter alone would let the row through; the length guard must still
    // drop it rather than let cosineSimilarity hand back a spurious 0.
    const mismatchedEmbedder: Embedder = {
      model: "m1",
      embed: () => Promise.resolve([[1, 0]]),
    };
    const scores = await semanticScoresForKind(projectId, "postgresql", "memory", mismatchedEmbedder);
    expect(scores.size).toBe(0);
  });

  it("ensureEmbeddings never throws when the embedder fails", async () => {
    const projectId = await seedProject();
    await seedMemory(projectId, MEM_A);
    await rebuildProjectProjection(projectId);

    const throwingEmbedder: Embedder = {
      model: "boom",
      embed: () => Promise.reject(new Error("network down")),
    };
    const result = await ensureEmbeddings(projectId, { embedder: throwingEmbedder });
    expect(result.embedded).toBe(0);
    expect(listEmbeddings(projectId, "memory")).toHaveLength(0);
  });
});

describe("embeddings math + config (unit)", () => {
  it("cosineSimilarity: identical=1, orthogonal=0, mismatched-length=0", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6); // same direction
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0); // length mismatch
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("reciprocalRankFusion: rewards items ranked high in multiple lists", () => {
    const fused = reciprocalRankFusion([
      ["a", "b", "c"],
      ["b", "a", "d"],
    ]);
    // 'a': 1/61 + 1/62, 'b': 1/61 + 1/62 — tie at top; both beat c and d.
    const ranked = [...fused.entries()].sort((x, y) => y[1] - x[1]).map((e) => e[0]);
    expect(ranked.slice(0, 2).sort()).toEqual(["a", "b"]);
    expect(fused.get("a")!).toBeGreaterThan(fused.get("c")!);
  });

  it("resolveEmbeddingsConfig: enabled by endpoint OR key, else off", () => {
    expect(resolveEmbeddingsConfig({})).toBeUndefined();
    expect(resolveEmbeddingsConfig({ MEMORIZE_EMBEDDINGS_API_KEY: "k" })).toMatchObject({
      apiKey: "k",
    });
    // Keyless local server: endpoint alone enables it (no apiKey field).
    const local = resolveEmbeddingsConfig({
      MEMORIZE_EMBEDDINGS_ENDPOINT: "http://localhost:11434/v1",
    });
    expect(local?.endpoint).toBe("http://localhost:11434/v1");
    expect(local?.apiKey).toBeUndefined();
  });
});

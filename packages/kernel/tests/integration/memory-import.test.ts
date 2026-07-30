import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConsolidatedMemory, createProject } from "../../src/domain/entities.js";
import type { ConsolidatorLlm, Embedder } from "../../src/index.js";
import { ExtractionParseError } from "../../src/services/consolidate-service.js";
import { IMPORT_MAX_ITEMS, importMemories } from "../../src/services/memory-import-service.js";
import { listOpenConflicts, listValidMemories } from "../../src/services/projection-store.js";
import { closeAll } from "../../src/storage/db.js";
import { appendEvent, readEvents } from "../../src/storage/event-store.js";

let sandbox: string;
let projectId: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-memory-import-"));
  process.env.MEMORIZE_ROOT = sandbox;

  const project = createProject({ title: "memory-import", rootPath: join(sandbox, "p") });
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

const alwaysContradicts: ConsolidatorLlm = {
  async complete(): Promise<string> {
    return '{"contradicts": true, "reason": "opposite datastore choice"}';
  },
};

describe("importMemories", () => {
  it("imports valid items, stamping provenance and defaulting empty provenance fields", async () => {
    const itemsJson = JSON.stringify([
      { kind: "decision", text: "Use SQLite for the local store", salience: 7 },
      { kind: "progress", text: "Ported the memory-import service", salience: 4 },
    ]);

    const result = await importMemories({
      projectId,
      actor: "test",
      source: "claude-memory",
      itemsJson,
    });

    expect(result).toEqual({ imported: 2, skippedDuplicates: 0, droppedByCap: 0 });

    const memories = listValidMemories(projectId).map((row) => row.memory);
    expect(memories).toHaveLength(2);
    for (const memory of memories) {
      expect(memory.importSource).toBe("claude-memory");
      expect(memory.sourceObservationIds).toEqual([]);
    }
  });

  it("rejects an empty source label without writing anything", async () => {
    const itemsJson = JSON.stringify([{ kind: "decision", text: "x", salience: 5 }]);
    await expect(
      importMemories({ projectId, actor: "test", source: "   ", itemsJson }),
    ).rejects.toThrow(/non-empty source/);
    expect(listValidMemories(projectId)).toHaveLength(0);
  });

  it("throws ExtractionParseError on malformed JSON input", async () => {
    await expect(
      importMemories({ projectId, actor: "test", source: "docs", itemsJson: "not json at all" }),
    ).rejects.toThrow(ExtractionParseError);
    expect(listValidMemories(projectId)).toHaveLength(0);
  });

  it("throws ExtractionParseError when the input has zero valid items", async () => {
    // A well-formed but empty array is a malformed CALL for import (unlike
    // consolidation, where an empty window is a legitimate no-op).
    await expect(
      importMemories({ projectId, actor: "test", source: "docs", itemsJson: "[]" }),
    ).rejects.toThrow(ExtractionParseError);

    // Same for an array whose only entries fail item-level validation.
    await expect(
      importMemories({
        projectId,
        actor: "test",
        source: "docs",
        itemsJson: JSON.stringify([{ kind: "not-a-kind", text: "x", salience: 5 }]),
      }),
    ).rejects.toThrow(ExtractionParseError);
    expect(listValidMemories(projectId)).toHaveLength(0);
  });

  it("skips items whose kind+text already exist as a valid memory (idempotency guard)", async () => {
    const itemsJson = JSON.stringify([
      { kind: "decision", text: "Use SQLite for the local store", salience: 7 },
    ]);
    const first = await importMemories({ projectId, actor: "test", source: "docs", itemsJson });
    expect(first).toEqual({ imported: 1, skippedDuplicates: 0, droppedByCap: 0 });

    // Re-running the same import (e.g. a retried agent call) must not duplicate.
    const second = await importMemories({ projectId, actor: "test", source: "docs", itemsJson });
    expect(second).toEqual({ imported: 0, skippedDuplicates: 1, droppedByCap: 0 });
    expect(listValidMemories(projectId)).toHaveLength(1);
  });

  it("dedupes within the same batch, case/whitespace-insensitively", async () => {
    const itemsJson = JSON.stringify([
      { kind: "decision", text: "Use SQLite for the local store", salience: 7 },
      { kind: "decision", text: "  USE SQLITE FOR THE LOCAL STORE  ", salience: 6 },
    ]);
    const result = await importMemories({ projectId, actor: "test", source: "docs", itemsJson });
    expect(result).toEqual({ imported: 1, skippedDuplicates: 1, droppedByCap: 0 });
  });

  it("caps unique new items at IMPORT_MAX_ITEMS and reports the drop via droppedByCap", async () => {
    const items = Array.from({ length: IMPORT_MAX_ITEMS + 20 }, (_, i) => ({
      kind: "progress" as const,
      text: `distilled note #${i}`,
      salience: 3,
    }));
    const result = await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson: JSON.stringify(items),
    });
    expect(result).toEqual({ imported: IMPORT_MAX_ITEMS, skippedDuplicates: 0, droppedByCap: 20 });
  });

  it("#114 ①: the cap applies to unique items AFTER dedup, so pre-existing duplicates cannot crowd out real new items", async () => {
    // Seed exactly IMPORT_MAX_ITEMS existing memories — these will all be
    // duplicates on the next import.
    const alreadyKnown = Array.from({ length: IMPORT_MAX_ITEMS }, (_, i) => ({
      kind: "progress" as const,
      text: `already known #${i}`,
      salience: 3,
    }));
    await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson: JSON.stringify(alreadyKnown),
    });
    expect(listValidMemories(projectId)).toHaveLength(IMPORT_MAX_ITEMS);

    // Re-run with the same IMPORT_MAX_ITEMS duplicates PLUS one genuinely new
    // item after them. Before the fix, parseExtractedMemories sliced to
    // IMPORT_MAX_ITEMS before dedup ran, so the new item never even reached
    // the loop — this would come back as { imported: 0, skippedDuplicates: 100 }
    // and the new item would be silently and permanently lost.
    const items = [
      ...alreadyKnown,
      { kind: "progress" as const, text: "brand new item past the duplicates", salience: 3 },
    ];
    const result = await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson: JSON.stringify(items),
    });

    expect(result).toEqual({
      imported: 1,
      skippedDuplicates: IMPORT_MAX_ITEMS,
      droppedByCap: 0,
    });
    const texts = listValidMemories(projectId).map((row) => row.memory.text);
    expect(texts).toContain("brand new item past the duplicates");
  });

  it("#114 ②: an event appended but never reflected in the projection (crash before rebuild) is still seen as a duplicate on retry", async () => {
    // Simulate a prior import call that appended the event but crashed before
    // its own rebuildProjectProjection — the projection has never heard of
    // this memory, so a naive read-then-append would re-import it.
    const memory = createConsolidatedMemory({
      projectId,
      kind: "decision",
      text: "Use SQLite for the local store",
      salience: 7,
      sourceObservationIds: [],
      importSource: "docs",
    });
    await appendEvent({
      type: "memory.consolidated",
      projectId,
      scopeType: "session",
      scopeId: projectId,
      actor: "test",
      payload: memory,
    });
    expect(listValidMemories(projectId)).toHaveLength(0); // projection not yet rebuilt

    const itemsJson = JSON.stringify([
      { kind: "decision", text: "Use SQLite for the local store", salience: 7 },
    ]);
    const result = await importMemories({ projectId, actor: "test", source: "docs", itemsJson });

    expect(result).toEqual({ imported: 0, skippedDuplicates: 1, droppedByCap: 0 });
    expect(listValidMemories(projectId)).toHaveLength(1);
  });

  it("#114 ②: two imports for the same project racing each other do not duplicate", async () => {
    const itemsJson = JSON.stringify([
      { kind: "decision", text: "Use SQLite for the local store", salience: 7 },
    ]);

    const [a, b] = await Promise.all([
      importMemories({ projectId, actor: "test", source: "docs", itemsJson }),
      importMemories({ projectId, actor: "test", source: "docs", itemsJson }),
    ]);

    expect(a.imported + b.imported).toBe(1);
    expect(a.skippedDuplicates + b.skippedDuplicates).toBe(1);
    expect(listValidMemories(projectId)).toHaveLength(1);
  });

  it("is a no-op event-wise when every item is a duplicate (no rebuild/embeddings/contradiction pass)", async () => {
    const itemsJson = JSON.stringify([
      { kind: "decision", text: "Use SQLite for the local store", salience: 7 },
    ]);
    await importMemories({ projectId, actor: "test", source: "docs", itemsJson });

    let embedCalls = 0;
    const countingEmbedder: Embedder = {
      model: "counting",
      async embed(texts: string[]): Promise<number[][]> {
        embedCalls += 1;
        return texts.map(() => [0]);
      },
    };

    const result = await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson,
      embedder: countingEmbedder,
    });
    expect(result).toEqual({ imported: 0, skippedDuplicates: 1, droppedByCap: 0 });
    expect(embedCalls).toBe(0);
  });

  it("triggers contradiction detection against existing memories when an embedder+llm are injected", async () => {
    const MEM_PG = "Chose PostgreSQL as the primary datastore";
    const MEM_SQLITE =
      "Chose SQLite as the primary datastore (reversing the earlier PostgreSQL call)";
    const vectors: Record<string, number[]> = {
      [MEM_PG]: [1, 0, 0],
      [MEM_SQLITE]: [0.95, 0.05, 0],
    };
    const embedder = fakeEmbedder(vectors);

    // Seed an existing valid decision memory + its embedding via a prior import.
    await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson: JSON.stringify([{ kind: "decision", text: MEM_PG, salience: 7 }]),
      embedder,
    });
    expect(listValidMemories(projectId)).toHaveLength(1);

    // Import a second, contradicting decision — should supersede the first
    // and raise a conflict, driven entirely by importMemories' own
    // post-append detectContradictions call.
    const result = await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson: JSON.stringify([{ kind: "decision", text: MEM_SQLITE, salience: 7 }]),
      embedder,
      llm: alwaysContradicts,
    });

    expect(result.imported).toBe(1);
    const validTexts = listValidMemories(projectId).map((row) => row.memory.text);
    expect(validTexts).toEqual([MEM_SQLITE]);
    expect(listOpenConflicts(projectId)).toHaveLength(1);
  });

  it("never contradicts (and never throws) when no llm is injected", async () => {
    const MEM_PG = "Chose PostgreSQL as the primary datastore";
    const MEM_SQLITE =
      "Chose SQLite as the primary datastore (reversing the earlier PostgreSQL call)";
    const vectors: Record<string, number[]> = {
      [MEM_PG]: [1, 0, 0],
      [MEM_SQLITE]: [0.95, 0.05, 0],
    };
    const embedder = fakeEmbedder(vectors);

    await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson: JSON.stringify([{ kind: "decision", text: MEM_PG, salience: 7 }]),
      embedder,
    });
    await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson: JSON.stringify([{ kind: "decision", text: MEM_SQLITE, salience: 7 }]),
      embedder,
    });

    expect(listValidMemories(projectId)).toHaveLength(2);
    expect(listOpenConflicts(projectId)).toHaveLength(0);
  });

  it("carries lifecycle-evidence fields through onto the stored memory", async () => {
    const itemsJson = JSON.stringify([
      {
        kind: "progress",
        text: "Old CLI flag --legacy-mode still referenced in docs",
        salience: 4,
        obsoleteWhen: "when the --legacy-mode flag is removed",
        kindMisfit: true,
        kindMisfitReason: "reads more like a TODO than progress",
        tags: ["cleanup", "docs"],
      },
    ]);
    await importMemories({ projectId, actor: "test", source: "docs", itemsJson });

    const [memory] = listValidMemories(projectId).map((row) => row.memory);
    expect(memory!.obsoleteWhen).toBe("when the --legacy-mode flag is removed");
    expect(memory!.kindMisfit).toBe(true);
    expect(memory!.kindMisfitReason).toBe("reads more like a TODO than progress");
    expect(memory!.tags).toEqual(["cleanup", "docs"]);
  });

  it("stamps sessionId on imported memories when provided", async () => {
    const itemsJson = JSON.stringify([{ kind: "decision", text: "x", salience: 5 }]);
    await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson,
      sessionId: "sess-1",
    });
    const [memory] = listValidMemories(projectId).map((row) => row.memory);
    expect(memory!.sessionId).toBe("sess-1");
  });
});

describe("importMemories — supersede hints (#114 ③)", () => {
  it("supersedes a currently-valid target id referenced by supersedesMemoryId", async () => {
    await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson: JSON.stringify([{ kind: "decision", text: "old truth", salience: 7 }]),
    });
    const oldId = listValidMemories(projectId)[0]!.memory.id;

    const result = await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson: JSON.stringify([
        {
          kind: "decision",
          text: "new truth",
          salience: 7,
          supersedesMemoryId: oldId,
          supersedeReason: "reversed",
        },
      ]),
    });

    expect(result.imported).toBe(1);
    expect(listValidMemories(projectId).map((row) => row.memory.text)).toEqual(["new truth"]);
    const superseded = (await readEvents(projectId)).filter(
      (event) => event.type === "memory.superseded",
    );
    expect(superseded).toHaveLength(1);
    expect(superseded[0]!.payload).toMatchObject({ supersedes: oldId, reason: "reversed" });
  });

  it("ignores a supersedesMemoryId that does not name a currently-valid memory — same discipline as consolidation", async () => {
    const result = await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson: JSON.stringify([
        {
          kind: "decision",
          text: "hallucinated supersede",
          salience: 7,
          supersedesMemoryId: "mem_does_not_exist",
        },
      ]),
    });

    expect(result.imported).toBe(1);
    expect(listValidMemories(projectId).map((row) => row.memory.text)).toEqual([
      "hallucinated supersede",
    ]);
    const superseded = (await readEvents(projectId)).filter(
      (event) => event.type === "memory.superseded",
    );
    expect(superseded).toHaveLength(0);
  });

  it("does not supersede a target twice within the same batch", async () => {
    await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson: JSON.stringify([{ kind: "decision", text: "old truth", salience: 7 }]),
    });
    const oldId = listValidMemories(projectId)[0]!.memory.id;

    const result = await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson: JSON.stringify([
        { kind: "decision", text: "replacement A", salience: 7, supersedesMemoryId: oldId },
        { kind: "decision", text: "replacement B", salience: 7, supersedesMemoryId: oldId },
      ]),
    });

    expect(result.imported).toBe(2);
    const superseded = (await readEvents(projectId)).filter(
      (event) => event.type === "memory.superseded",
    );
    expect(superseded).toHaveLength(1);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION } from "../../src/domain/common.js";
import {
  createConsolidatedMemory,
  createObservation,
  createProject,
} from "../../src/domain/entities.js";
import type { ConsolidatorLlm, Embedder } from "../../src/index.js";
import { ExtractionParseError } from "../../src/services/consolidate-service.js";
import { IMPORT_MAX_ITEMS, importMemories } from "../../src/services/memory-import-service.js";
import {
  listOpenConflicts,
  listRecentObservations,
  listValidMemories,
  rebuildProjectProjection,
} from "../../src/services/projection-store.js";
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

    expect(result).toEqual({
      imported: 2,
      skippedDuplicates: 0,
      droppedByCap: 0,
      honoredSupersedes: 0,
      droppedSupersedesByCap: 0,
    });

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
    expect(first).toEqual({
      imported: 1,
      skippedDuplicates: 0,
      droppedByCap: 0,
      honoredSupersedes: 0,
      droppedSupersedesByCap: 0,
    });

    // Re-running the same import (e.g. a retried agent call) must not duplicate.
    const second = await importMemories({ projectId, actor: "test", source: "docs", itemsJson });
    expect(second).toEqual({
      imported: 0,
      skippedDuplicates: 1,
      droppedByCap: 0,
      honoredSupersedes: 0,
      droppedSupersedesByCap: 0,
    });
    expect(listValidMemories(projectId)).toHaveLength(1);
  });

  it("dedupes within the same batch, case/whitespace-insensitively", async () => {
    const itemsJson = JSON.stringify([
      { kind: "decision", text: "Use SQLite for the local store", salience: 7 },
      { kind: "decision", text: "  USE SQLITE FOR THE LOCAL STORE  ", salience: 6 },
    ]);
    const result = await importMemories({ projectId, actor: "test", source: "docs", itemsJson });
    expect(result).toEqual({
      imported: 1,
      skippedDuplicates: 1,
      droppedByCap: 0,
      honoredSupersedes: 0,
      droppedSupersedesByCap: 0,
    });
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
    expect(result).toEqual({
      imported: IMPORT_MAX_ITEMS,
      skippedDuplicates: 0,
      droppedByCap: 20,
      honoredSupersedes: 0,
      droppedSupersedesByCap: 0,
    });
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
      honoredSupersedes: 0,
      droppedSupersedesByCap: 0,
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

    expect(result).toEqual({
      imported: 0,
      skippedDuplicates: 1,
      droppedByCap: 0,
      honoredSupersedes: 0,
      droppedSupersedesByCap: 0,
    });
    // The guarantee is "the crashed call's memory is not imported twice", and
    // the event log is where that is decided. #137 ③ moved the dedup snapshot
    // off the projection, so the stale projection is no longer repaired as a
    // side effect of reading it — the log still holds exactly one copy.
    const consolidated = (await readEvents(projectId)).filter(
      (event) => event.type === "memory.consolidated",
    );
    expect(consolidated).toHaveLength(1);
    // ...and the projection is exactly as the import found it. Reading for
    // dedup writes NOTHING now (#137 ③) — before, this same call rebuilt the
    // whole projection, which is how it could roll back a concurrent writer.
    expect(listValidMemories(projectId)).toHaveLength(0);
  });

  it("#137 ③: a concurrent writer's projection row survives an overlapping duplicate-only import", async () => {
    const itemsJson = JSON.stringify([
      { kind: "decision", text: "Use SQLite for the local store", salience: 7 },
    ]);
    await importMemories({ projectId, actor: "test", source: "docs", itemsJson });

    // An imported rule gives the pre-dedup rebuild the old code ran a real
    // topic-`.md` disk read to await (`reindexSearch: true`), which is the
    // window this issue is about: snapshot taken, event loop yielded, and
    // only then the DELETE-and-reload transaction.
    await appendEvent({
      type: "rule.upserted",
      projectId,
      scopeType: "project",
      scopeId: projectId,
      actor: "system-import",
      payload: {
        id: "rule_topic_window",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        scopeType: "project",
        scopeId: projectId,
        title: "Imported CLAUDE.md",
        body: "topic body",
        priority: 100,
        source: "imported",
        updatedBy: "system-import",
      } as never,
    });

    // Every item is a duplicate, so this import appends nothing — and
    // therefore never rebuilds afterwards either. Whatever it does to the
    // projection on the way in is the final state.
    const importPromise = importMemories({ projectId, actor: "test", source: "docs", itemsJson });
    await Promise.resolve(); // let the import take its dedup snapshot first

    // Capture's shape (`capture-service`: append + rebuild), which importLocks
    // does not exclude — this observation is younger than the snapshot above.
    await appendEvent({
      type: "observation.captured",
      projectId,
      scopeType: "session",
      scopeId: projectId,
      actor: "test",
      payload: createObservation({
        projectId,
        signal: "decision-keyword",
        summary: "chose better-sqlite3",
        toolName: "Bash",
      }),
    });
    await rebuildProjectProjection(projectId, { reindexSearch: false });

    expect(await importPromise).toEqual({
      imported: 0,
      skippedDuplicates: 1,
      droppedByCap: 0,
      honoredSupersedes: 0,
      droppedSupersedesByCap: 0,
    });
    expect(listRecentObservations(projectId, { limit: 10 })).toHaveLength(1);
  });

  it("#137 ①: releasing a settled lock entry never lets a later import overtake a queued one", async () => {
    // A runs, B queues behind it, and C arrives only AFTER A has settled. If
    // the settled entry were dropped unconditionally, A's release would evict
    // the entry B is the tail of, C would find an empty map and start
    // immediately — running concurrently with B, which is exactly the
    // serialization #114 ② established.
    const order: string[] = [];
    const gate = (name: string, open: Promise<void>): Embedder => {
      let firstCall = true;
      return {
        model: "gated",
        async embed(texts: string[]): Promise<number[][]> {
          if (firstCall) {
            firstCall = false;
            order.push(`${name}:enter`);
            await open;
            order.push(`${name}:exit`);
          }
          return texts.map(() => [0]);
        },
      };
    };
    const opener = (): { open: Promise<void>; release: () => void } => {
      let release!: () => void;
      const open = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { open, release };
    };
    const start = (name: string, open: Promise<void>): Promise<unknown> =>
      importMemories({
        projectId,
        actor: "test",
        source: "docs",
        itemsJson: JSON.stringify([{ kind: "progress", text: `note ${name}`, salience: 3 }]),
        embedder: gate(name, open),
      });

    const gateA = opener();
    const gateB = opener();
    const gateC = opener();
    const a = start("a", gateA.open);
    const b = start("b", gateB.open); // queues behind A
    gateA.release();
    await a; // A has settled; B holds the lock
    await new Promise((resolve) => setImmediate(resolve)); // A's release runs

    const c = start("c", gateC.open);
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).not.toContain("c:enter"); // C must still be waiting on B

    gateB.release();
    await b;
    gateC.release();
    await c;
    expect(order).toEqual(["a:enter", "a:exit", "b:enter", "b:exit", "c:enter", "c:exit"]);
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
    expect(result).toEqual({
      imported: 0,
      skippedDuplicates: 1,
      droppedByCap: 0,
      honoredSupersedes: 0,
      droppedSupersedesByCap: 0,
    });
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

  it("#137 ②: honors the supersede hint of an item folded as a duplicate, attributing it to the memory the item folded into", async () => {
    await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson: JSON.stringify([
        { kind: "decision", text: "old truth", salience: 7 },
        { kind: "decision", text: "new truth", salience: 7 },
      ]),
    });
    const byText = new Map(
      listValidMemories(projectId).map((row) => [row.memory.text, row.memory.id]),
    );
    const oldId = byText.get("old truth")!;
    const newId = byText.get("new truth")!;

    // "new truth" already exists, so the item is a duplicate — but this time
    // it carries the claim that it replaces "old truth". Before the fix the
    // `continue` dropped the item whole and `oldId` stayed valid, with no
    // failure reported to the caller.
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

    expect(result).toEqual({
      imported: 0,
      skippedDuplicates: 1,
      droppedByCap: 0,
      honoredSupersedes: 1,
      droppedSupersedesByCap: 0,
    });
    expect(listValidMemories(projectId).map((row) => row.memory.text)).toEqual(["new truth"]);
    const superseded = (await readEvents(projectId)).filter(
      (event) => event.type === "memory.superseded",
    );
    expect(superseded).toHaveLength(1);
    // Attributed to the already-valid memory the duplicate folded into — no
    // second copy of "new truth" is minted just to carry the hint.
    expect(superseded[0]!.payload).toMatchObject({
      supersedes: oldId,
      supersededBy: newId,
      reason: "reversed",
    });
  });

  it("#137 ②: honors the supersede hint of an in-batch duplicate, attributing it to the item's first occurrence", async () => {
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
        { kind: "decision", text: "new truth", salience: 7 },
        { kind: "decision", text: "new truth", salience: 7, supersedesMemoryId: oldId },
      ]),
    });

    expect(result).toEqual({
      imported: 1,
      skippedDuplicates: 1,
      droppedByCap: 0,
      honoredSupersedes: 1,
      droppedSupersedesByCap: 0,
    });
    const newId = listValidMemories(projectId).find((row) => row.memory.text === "new truth")!
      .memory.id;
    const superseded = (await readEvents(projectId)).filter(
      (event) => event.type === "memory.superseded",
    );
    expect(superseded).toHaveLength(1);
    expect(superseded[0]!.payload).toMatchObject({ supersedes: oldId, supersededBy: newId });
  });

  it("#137 ②: ignores a folded duplicate's hint when it does not name a currently-valid memory", async () => {
    await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson: JSON.stringify([{ kind: "decision", text: "new truth", salience: 7 }]),
    });

    const result = await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson: JSON.stringify([
        {
          kind: "decision",
          text: "new truth",
          salience: 7,
          supersedesMemoryId: "mem_does_not_exist",
        },
      ]),
    });

    expect(result).toEqual({
      imported: 0,
      skippedDuplicates: 1,
      droppedByCap: 0,
      honoredSupersedes: 0,
      droppedSupersedesByCap: 0,
    });
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

  it("ignores a folded duplicate's hint when the memory it folded into was already retired by this same batch", async () => {
    await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson: JSON.stringify([
        { kind: "decision", text: "a truth", salience: 7 },
        { kind: "decision", text: "b truth", salience: 7 },
      ]),
    });
    const byText = new Map(
      listValidMemories(projectId).map((row) => [row.memory.text, row.memory.id]),
    );
    const aId = byText.get("a truth")!;
    const bId = byText.get("b truth")!;

    // One item mints a replacement for A. A LATER item is a duplicate of A's
    // own text, so it folds into A — and claims to retire B. Honoring that
    // would retire B naming A as its replacement, except A is already dead by
    // the time the folded loop runs: B would be left with no valid successor.
    const result = await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson: JSON.stringify([
        { kind: "decision", text: "replaces a", salience: 7, supersedesMemoryId: aId },
        { kind: "decision", text: "a truth", salience: 7, supersedesMemoryId: bId },
      ]),
    });

    expect(result).toEqual({
      imported: 1,
      skippedDuplicates: 1,
      droppedByCap: 0,
      honoredSupersedes: 1,
      droppedSupersedesByCap: 0,
    });
    const superseded = (await readEvents(projectId)).filter(
      (event) => event.type === "memory.superseded",
    );
    expect(superseded).toHaveLength(1);
    expect(superseded[0]!.payload).toMatchObject({ supersedes: aId });
    // B survives — the only memory that could have replaced it is itself gone.
    expect(
      listValidMemories(projectId)
        .map((row) => row.memory.text)
        .sort(),
    ).toEqual(["b truth", "replaces a"]);
  });

  it("#165: a folded hint's author retired by a LATER folded hint in the same batch does not produce a dangling successor", async () => {
    // Three pre-existing memories: T is what "m" claims to replace, and "n"
    // later claims to replace "m" itself.
    await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson: JSON.stringify([
        { kind: "decision", text: "m", salience: 7 },
        { kind: "decision", text: "n", salience: 7 },
        { kind: "decision", text: "t", salience: 7 },
      ]),
    });
    const byText = new Map(
      listValidMemories(projectId).map((row) => [row.memory.text, row.memory.id]),
    );
    const mId = byText.get("m")!;
    const tId = byText.get("t")!;

    // Both items are duplicates of existing text, so both fold. The
    // sequential guard only sees retirements EARLIER in this order — "m"
    // retiring T is honored before anything has retired "m" — so before the
    // fix this produced a `memory.superseded` for T naming M, and a second
    // one for M naming N right after, leaving T's successor dead.
    const result = await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson: JSON.stringify([
        { kind: "decision", text: "m", salience: 7, supersedesMemoryId: tId },
        { kind: "decision", text: "n", salience: 7, supersedesMemoryId: mId },
      ]),
    });

    expect(result).toEqual({
      imported: 0,
      skippedDuplicates: 2,
      droppedByCap: 0,
      honoredSupersedes: 1,
      droppedSupersedesByCap: 0,
    });
    const superseded = (await readEvents(projectId)).filter(
      (event) => event.type === "memory.superseded",
    );
    // Only M's own retirement (by N) is honored — T is never named as
    // retired, since its would-be successor (M) dies in this same batch.
    expect(superseded).toHaveLength(1);
    expect(superseded[0]!.payload).toMatchObject({ supersedes: mId });
    expect(
      listValidMemories(projectId)
        .map((row) => row.memory.text)
        .sort(),
    ).toEqual(["n", "t"]);
  });

  it("#165: order symmetry — reversing the two chained folded hints yields the identical result", async () => {
    await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson: JSON.stringify([
        { kind: "decision", text: "m", salience: 7 },
        { kind: "decision", text: "n", salience: 7 },
        { kind: "decision", text: "t", salience: 7 },
      ]),
    });
    const byText = new Map(
      listValidMemories(projectId).map((row) => [row.memory.text, row.memory.id]),
    );
    const mId = byText.get("m")!;
    const tId = byText.get("t")!;

    // Same batch content as the previous test, items in the opposite order —
    // this direction already passed under the sequential guard (N retires M
    // before M's own hint is looked at), so it anchors what BOTH orders must
    // now produce.
    const result = await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson: JSON.stringify([
        { kind: "decision", text: "n", salience: 7, supersedesMemoryId: mId },
        { kind: "decision", text: "m", salience: 7, supersedesMemoryId: tId },
      ]),
    });

    expect(result).toEqual({
      imported: 0,
      skippedDuplicates: 2,
      droppedByCap: 0,
      honoredSupersedes: 1,
      droppedSupersedesByCap: 0,
    });
    const superseded = (await readEvents(projectId)).filter(
      (event) => event.type === "memory.superseded",
    );
    expect(superseded).toHaveLength(1);
    expect(superseded[0]!.payload).toMatchObject({ supersedes: mId });
    expect(
      listValidMemories(projectId)
        .map((row) => row.memory.text)
        .sort(),
    ).toEqual(["n", "t"]);
  });

  it("bounds folded supersede hints by the invocation cap and reports the overflow", async () => {
    // Seed the fold target plus IMPORT_MAX_ITEMS + 5 distinct supersede
    // targets. Two calls because seeding itself is capped.
    const targetTexts = Array.from({ length: IMPORT_MAX_ITEMS + 5 }, (_, i) => `target ${i}`);
    for (const chunk of [
      ["folded text", ...targetTexts.slice(0, IMPORT_MAX_ITEMS - 1)],
      targetTexts.slice(IMPORT_MAX_ITEMS - 1),
    ]) {
      await importMemories({
        projectId,
        actor: "test",
        source: "docs",
        itemsJson: JSON.stringify(chunk.map((text) => ({ kind: "decision", text, salience: 5 }))),
      });
    }
    const idByText = new Map(
      listValidMemories(projectId).map((row) => [row.memory.text, row.memory.id]),
    );

    // Every item is an existing-text duplicate, so `uniqueNewItems` is empty
    // and the cap on minted items never engages — yet each carries a distinct
    // valid target. Unbudgeted, this retires all 105 while reporting
    // `droppedByCap: 0`.
    const result = await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson: JSON.stringify(
        targetTexts.map((text) => ({
          kind: "decision",
          text: "folded text",
          salience: 5,
          supersedesMemoryId: idByText.get(text)!,
        })),
      ),
    });

    expect(result).toEqual({
      imported: 0,
      skippedDuplicates: IMPORT_MAX_ITEMS + 5,
      droppedByCap: 0,
      honoredSupersedes: IMPORT_MAX_ITEMS,
      droppedSupersedesByCap: 5,
    });
    const superseded = (await readEvents(projectId)).filter(
      (event) => event.type === "memory.superseded",
    );
    expect(superseded).toHaveLength(IMPORT_MAX_ITEMS);
    // The last 5 targets kept their budget-less hints and stayed valid.
    const stillValid = new Set(listValidMemories(projectId).map((row) => row.memory.text));
    expect(targetTexts.filter((text) => stillValid.has(text))).toEqual(
      targetTexts.slice(IMPORT_MAX_ITEMS),
    );
  });

  it("spends the cap on minted items first, and a re-run converges the hints it could not fit", async () => {
    await importMemories({
      projectId,
      actor: "test",
      source: "docs",
      itemsJson: JSON.stringify([
        { kind: "decision", text: "folded text", salience: 5 },
        { kind: "decision", text: "old truth", salience: 5 },
      ]),
    });
    const oldId = listValidMemories(projectId).find((row) => row.memory.text === "old truth")!
      .memory.id;

    // IMPORT_MAX_ITEMS genuinely new items exhaust the budget, so the one
    // folded hint riding along has no room left.
    const itemsJson = JSON.stringify([
      ...Array.from({ length: IMPORT_MAX_ITEMS }, (_, i) => ({
        kind: "decision",
        text: `fresh ${i}`,
        salience: 5,
      })),
      { kind: "decision", text: "folded text", salience: 5, supersedesMemoryId: oldId },
    ]);

    expect(await importMemories({ projectId, actor: "test", source: "docs", itemsJson })).toEqual({
      imported: IMPORT_MAX_ITEMS,
      skippedDuplicates: 1,
      droppedByCap: 0,
      honoredSupersedes: 0,
      droppedSupersedesByCap: 1,
    });
    expect(listValidMemories(projectId).map((row) => row.memory.text)).toContain("old truth");

    // The documented remedy: re-run. The items minted above now fold, freeing
    // the whole budget for the hint — so this terminates rather than looping.
    expect(await importMemories({ projectId, actor: "test", source: "docs", itemsJson })).toEqual({
      imported: 0,
      skippedDuplicates: IMPORT_MAX_ITEMS + 1,
      droppedByCap: 0,
      honoredSupersedes: 1,
      droppedSupersedesByCap: 0,
    });
    expect(listValidMemories(projectId).map((row) => row.memory.text)).not.toContain("old truth");
  });
});

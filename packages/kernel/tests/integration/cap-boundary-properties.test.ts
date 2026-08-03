import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProject } from "../../src/domain/entities.js";
import { IMPORT_MAX_ITEMS, importMemories } from "../../src/services/memory-import-service.js";
import { listValidMemories } from "../../src/services/projection-store.js";
import {
  insertSegments,
  listSegments,
  pruneSegments,
  type NewSegmentRow,
} from "../../src/services/segment-store.js";
import { closeAll } from "../../src/storage/db.js";
import { appendEvent } from "../../src/storage/event-store.js";
import { forAll } from "../support/property.js";

/**
 * #208 (#188 B) — cap-boundary properties, promoted from example tests to
 * randomized invariants so the boundary-condition space (batch size vs. the
 * cap, duplicate density, tie clusters) isn't limited to the handful of
 * shapes a human picked. Each property targets one already-fixed historical
 * defect (named in its `it` title) and is proven to actually depend on that
 * fix — see the PR body for the revert-and-fail transcripts.
 *
 * Iteration counts are fixed and modest by design (30 for the import-path
 * properties, 60 for the lighter pure-SQLite segment property): CI budget
 * per TESTING.md is ~2 minutes for the whole suite, and each import-path run
 * does a full appendEvents+rebuildProjectProjection round trip comparable to
 * one existing `memory-import.test.ts` case, so 30 runs costs about as much
 * as 30 ordinary test cases. See the PR body for measured wall-clock.
 */

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-cap-property-"));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

async function freshProject(title: string): Promise<string> {
  const project = createProject({ title, rootPath: join(sandbox, title) });
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

/** Same normalization `memory-import-service.ts` documents for its dedup key. */
function normKey(kind: string, text: string): string {
  return `${kind}\n${text.trim().toLowerCase()}`;
}

describe("cap-boundary property: memory-import-service.ts IMPORT_MAX_ITEMS (invariant 1 — cap applies AFTER the dedup filter, #114 ①)", () => {
  it("imported+droppedByCap always equal min/max of the cap against the DEDUPED batch, never the raw batch", async () => {
    await forAll(
      "import-cap-after-filter",
      { runs: 30, seed: 20800 },
      (rng) => {
        const existingCount = rng.int(0, 15);
        const existingTexts = Array.from({ length: existingCount }, (_, i) => `seed-text-${i}`);

        const batchSize = rng.int(1, 130);
        const dupProbability = rng.next() * 0.6; // 0..0.6, varies per run
        const batch: Array<{ kind: "progress"; text: string; salience: number }> = [];
        const inBatchUniqueTexts: string[] = [];
        for (let i = 0; i < batchSize; i++) {
          const canDup =
            existingTexts.length + inBatchUniqueTexts.length > 0 && rng.bool(dupProbability);
          const text = canDup
            ? rng.pick([...existingTexts, ...inBatchUniqueTexts])
            : `fresh-${i}-${rng.int(0, 1_000_000)}`;
          if (!canDup) inBatchUniqueTexts.push(text);
          batch.push({ kind: "progress", text, salience: 5 });
        }
        return { existingTexts, batch };
      },
      async ({ existingTexts, batch }) => {
        const projectId = await freshProject("import-cap-order");
        if (existingTexts.length > 0) {
          await importMemories({
            projectId,
            actor: "test",
            source: "seed",
            itemsJson: JSON.stringify(
              existingTexts.map((text) => ({ kind: "progress", text, salience: 5 })),
            ),
          });
        }

        // Expected: dedup the batch (kind+normalized text) against existing +
        // in-batch-earlier items ONLY — no cap involved yet.
        const seen = new Set(existingTexts.map((t) => normKey("progress", t)));
        const uniqueNewItems: Array<{ text: string }> = [];
        let expectedSkipped = 0;
        for (const item of batch) {
          const key = normKey(item.kind, item.text);
          if (seen.has(key)) {
            expectedSkipped += 1;
            continue;
          }
          seen.add(key);
          uniqueNewItems.push(item);
        }
        const expectedImported = Math.min(uniqueNewItems.length, IMPORT_MAX_ITEMS);
        const expectedDroppedByCap = Math.max(0, uniqueNewItems.length - IMPORT_MAX_ITEMS);
        // Invariant 1: "top N of the filter-only survivors" == "what the
        // capped call actually keeps". Computed independently here (no cap
        // applied yet) so a cap-before-filter bug has something to disagree with.
        const expectedKeptKeys = new Set(
          uniqueNewItems.slice(0, IMPORT_MAX_ITEMS).map((item) => normKey("progress", item.text)),
        );

        const result = await importMemories({
          projectId,
          actor: "test",
          source: "batch",
          itemsJson: JSON.stringify(batch),
        });

        expect(result.imported).toBe(expectedImported);
        expect(result.droppedByCap).toBe(expectedDroppedByCap);
        expect(result.skippedDuplicates).toBe(expectedSkipped);

        const actualKeptKeys = new Set(
          listValidMemories(projectId)
            .map((row) => row.memory)
            .filter((memory) => memory.importSource === "batch")
            .map((memory) => normKey(memory.kind, memory.text)),
        );
        expect(actualKeptKeys).toEqual(expectedKeptKeys);
      },
    );
  });
});

describe("cap-boundary property: segment-store.ts pruneSegments count cap (invariant 2 — survivors are always the priority-top-N, #116)", () => {
  it("never drops a segment that outranks (newer created_at, or same created_at + higher ordinal than) a segment it keeps", async () => {
    await forAll(
      "segment-prune-top-n",
      { runs: 60, seed: 11600 },
      (rng) => {
        const boundaryCount = rng.int(1, 10);
        // Distinct minute offsets so createdAt values are strictly ordered
        // across boundaries; ordinals are unique within a boundary — together
        // every (createdAt, ordinal) pair is globally unique, so "priority
        // rank" below is unambiguous.
        const offsets = new Set<number>();
        while (offsets.size < boundaryCount) offsets.add(rng.int(0, 500));
        const boundaries = [...offsets].map((offsetMin) => ({
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, offsetMin, 0)).toISOString(),
          size: rng.int(1, 8),
        }));

        const segments: NewSegmentRow[] = [];
        let counter = 0;
        for (const boundary of boundaries) {
          for (let ordinal = 0; ordinal < boundary.size; ordinal++) {
            segments.push({
              id: `seg-${counter++}`,
              text: `text-${counter}`,
              createdAt: boundary.createdAt,
              ordinal,
            });
          }
        }
        const maxCount = rng.int(0, segments.length + 5);
        return { segments, maxCount };
      },
      async ({ segments, maxCount }) => {
        const projectId = await freshProject("segment-prune-cap");
        insertSegments(projectId, segments);

        // Priority order: newest created_at first, ties broken by higher
        // ordinal — same order pruneSegments' own SELECT uses.
        const ranked = [...segments].sort((a, b) => {
          if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
          return b.ordinal - a.ordinal;
        });
        const expectedKeptIds = new Set(ranked.slice(0, maxCount).map((s) => s.id));
        const expectedDroppedIds = new Set(ranked.slice(maxCount).map((s) => s.id));

        // Age cutoff pushed far in the past so only the count cap is exercised.
        const deleted = pruneSegments(projectId, {
          maxAgeDays: 3650,
          maxCount,
          nowMs: Date.UTC(2026, 0, 2, 0, 0, 0),
        });

        expect(new Set(deleted)).toEqual(expectedDroppedIds);
        const remainingIds = new Set(listSegments(projectId).map((s) => s.id));
        expect(remainingIds).toEqual(expectedKeptIds);

        // Restated directly in the invariant's own terms (redundant with the
        // set-equality checks above given every rank is unique, but this is
        // the literal "no drop outranks a keep" property #116 exists for).
        const rankOf = new Map(ranked.map((s, index) => [s.id, index]));
        for (const droppedId of deleted) {
          for (const keptId of remainingIds) {
            expect(rankOf.get(droppedId)!).toBeGreaterThan(rankOf.get(keptId)!);
          }
        }
      },
    );
  });
});

describe("cap-boundary property: memory-import-service.ts report-value completeness (invariant 3 — no input item vanishes from every bucket, guards the #206 ② failure shape)", () => {
  it("imported+skippedDuplicates+droppedByCap always equal the batch size, and every clean (non-competing, non-chained) supersede hint is honored xor cap-dropped", async () => {
    await forAll(
      "import-report-completeness",
      { runs: 30, seed: 20801 },
      (rng) => {
        // 2*hintCount existing memories: the first half is duplicated (as the
        // hint's author/`supersededBy`), the second half is targeted (as
        // `supersedesMemoryId`) — the two pools are disjoint, so no hint's
        // author is ever another hint's target. That rules out the chain /
        // rival-competition shapes #206 (a SEPARATE, still-open issue) is
        // about — this property covers the budget accounting itself, not
        // that unresolved chain-resolution question. See PR body.
        const hintCount = rng.int(0, 5);
        const existingCount = Math.max(2 * hintCount, rng.int(0, 10));
        const existingTexts = Array.from({ length: existingCount }, (_, i) => `existing-${i}`);

        let uniqueNewCount = rng.int(0, 130);
        const plainDupCount = rng.int(0, Math.max(0, existingCount - 2 * hintCount));
        // importMemories rejects a wholly empty batch (distinct call from
        // this seeding one) — force at least one item so every run is valid.
        if (uniqueNewCount === 0 && hintCount === 0 && plainDupCount === 0) uniqueNewCount = 1;

        return { existingTexts, hintCount, uniqueNewCount, plainDupCount };
      },
      async ({ existingTexts, hintCount, uniqueNewCount, plainDupCount }) => {
        const projectId = await freshProject("import-report-completeness");
        if (existingTexts.length > 0) {
          await importMemories({
            projectId,
            actor: "test",
            source: "seed",
            itemsJson: JSON.stringify(
              existingTexts.map((text) => ({ kind: "progress", text, salience: 5 })),
            ),
          });
        }
        const existingIdByText = new Map(
          listValidMemories(projectId).map((row) => [row.memory.text, row.memory.id]),
        );

        const authorTexts = existingTexts.slice(0, hintCount);
        const targetTexts = existingTexts.slice(hintCount, 2 * hintCount);
        const plainDupTexts = existingTexts.slice(2 * hintCount, 2 * hintCount + plainDupCount);

        const batch: Array<{
          kind: "progress";
          text: string;
          salience: number;
          supersedesMemoryId?: string;
        }> = [];
        for (let i = 0; i < uniqueNewCount; i++) {
          batch.push({ kind: "progress", text: `fresh-${i}`, salience: 5 });
        }
        for (let i = 0; i < hintCount; i++) {
          batch.push({
            kind: "progress",
            text: authorTexts[i]!,
            salience: 5,
            supersedesMemoryId: existingIdByText.get(targetTexts[i]!)!,
          });
        }
        for (const text of plainDupTexts) {
          batch.push({ kind: "progress", text, salience: 5 });
        }

        const totalBatchItems = batch.length;
        const expectedImported = Math.min(uniqueNewCount, IMPORT_MAX_ITEMS);
        const expectedDroppedByCap = Math.max(0, uniqueNewCount - IMPORT_MAX_ITEMS);
        const expectedBudget = IMPORT_MAX_ITEMS - expectedImported;
        const expectedHonored = Math.min(hintCount, expectedBudget);
        const expectedDroppedSupersedesByCap = hintCount - expectedHonored;

        const result = await importMemories({
          projectId,
          actor: "test",
          source: "batch",
          itemsJson: JSON.stringify(batch),
        });

        // Coarse partition: every batch item lands in exactly one of these
        // three buckets (folded hints are counted in skippedDuplicates
        // regardless of hint outcome — see MemoryImportResult's own doc).
        expect(result.imported + result.skippedDuplicates + result.droppedByCap).toBe(
          totalBatchItems,
        );
        expect(result.imported).toBe(expectedImported);
        expect(result.droppedByCap).toBe(expectedDroppedByCap);

        // Fine-grained: every clean supersede hint is honored xor counted as
        // a cap drop — never simply absent from both counters.
        expect(result.honoredSupersedes).toBe(expectedHonored);
        expect(result.droppedSupersedesByCap).toBe(expectedDroppedSupersedesByCap);
        expect(result.honoredSupersedes + result.droppedSupersedesByCap).toBe(hintCount);
      },
    );
  });
});

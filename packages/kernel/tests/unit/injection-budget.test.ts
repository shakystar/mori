/**
 * `fitInjectionBudget`'s drop record (#242 1/2) — the primitive that answers
 * "what got cut, and in what order" for the entries the #238 trim removes.
 * Pure: no store, no clock; fixtures are handed to the function directly
 * rather than retrieved, so overflow is exact and deterministic instead of
 * depending on ranking/search behaviour covered elsewhere.
 */

import { describe, expect, it } from "vitest";

import { createConsolidatedMemory, createObservation } from "../../src/domain/entities.js";
import { fitInjectionBudget } from "../../src/services/injection-budget.js";
import type {
  RankedPoolEntry,
  RetrievedSegment,
} from "../../src/services/memory-retrieval-service.js";

const PROJECT_ID = "proj_budget_unit";

/** A pool entry whose text is large enough that a handful of them overflow the ceiling. */
function memoryEntry(id: string, score: number): RankedPoolEntry {
  return {
    channel: "memory",
    memory: {
      memory: {
        ...createConsolidatedMemory({
          projectId: PROJECT_ID,
          kind: "decision",
          text: `memory ${id}: `.padEnd(400, "x"),
          salience: 5,
        }),
        id,
      },
      score,
    },
  };
}

function observationEntry(id: string, score: number): RankedPoolEntry {
  return {
    channel: "observation",
    observation: {
      ...createObservation({
        projectId: PROJECT_ID,
        signal: "decision-keyword",
        summary: `observation ${id}: `.padEnd(300, "x"),
      }),
      id,
    },
    score,
  };
}

function segment(id: string, score: number): RetrievedSegment {
  return { id, text: `segment ${id}: `.padEnd(300, "x"), score };
}

describe("fitInjectionBudget", () => {
  it("accounts for every input entry as either survived or dropped, in drop order", () => {
    const ranked: RankedPoolEntry[] = [
      ...Array.from({ length: 10 }, (_, i) => memoryEntry(`mem_${i}`, 100 - i)),
      ...Array.from({ length: 10 }, (_, i) => observationEntry(`obs_${i}`, 80 - i)),
    ];
    const segments: RetrievedSegment[] = Array.from({ length: 10 }, (_, i) =>
      segment(`seg_${i}`, 10 - i),
    );

    const { context, dropped } = fitInjectionBudget({ ranked, segments });

    const survivedCount =
      (context.consolidatedMemories?.length ?? 0) +
      (context.recentObservations?.length ?? 0) +
      (context.rawSegments?.length ?? 0);
    expect(survivedCount + dropped.length).toBe(ranked.length + segments.length);
    // Nothing is silently missing: this corpus really does overflow.
    expect(dropped.length).toBeGreaterThan(0);
    // Drop order is a dense 1..N sequence — every cut is numbered, none skipped.
    expect(dropped.map((d) => d.order)).toEqual(dropped.map((_, i) => i + 1));
  });

  it("returns an empty drop list when the corpus fits within budget", () => {
    const ranked: RankedPoolEntry[] = [memoryEntry("mem_0", 10), observationEntry("obs_0", 5)];
    const segments: RetrievedSegment[] = [segment("seg_0", 1)];

    const { context, dropped } = fitInjectionBudget({ ranked, segments });

    expect(dropped).toEqual([]);
    expect(context.consolidatedMemories?.map((m) => m.id)).toEqual(["mem_0"]);
    expect(context.recentObservations).toHaveLength(1);
    expect(context.rawSegments?.map((s) => s.id)).toEqual(["seg_0"]);
  });

  it("drops every segment before touching the ranked pool, and the drop order reflects it", () => {
    const ranked: RankedPoolEntry[] = Array.from({ length: 10 }, (_, i) =>
      memoryEntry(`mem_${i}`, 100 - i),
    );
    const segments: RetrievedSegment[] = Array.from({ length: 10 }, (_, i) =>
      segment(`seg_${i}`, 10 - i),
    );

    const { dropped } = fitInjectionBudget({ ranked, segments });

    const segmentDrops = dropped.filter((d) => d.channel === "segment");
    const poolDrops = dropped.filter((d) => d.channel === "memory");
    expect(segmentDrops.length).toBeGreaterThan(0);
    // Every segment drop's order precedes every pool drop's order — the
    // existing "segments can never evict consolidated memories" priority,
    // now visible in the recorded order rather than just in behaviour.
    if (poolDrops.length > 0) {
      const lastSegmentOrder = Math.max(...segmentDrops.map((d) => d.order));
      const firstPoolOrder = Math.min(...poolDrops.map((d) => d.order));
      expect(lastSegmentOrder).toBeLessThan(firstPoolOrder);
    }
    // And the dropped segment ids are exactly the worst-ranked ones (lowest
    // score first cut), matching the input's own worst-first ordering.
    expect(segmentDrops.map((d) => d.id)).toEqual(
      [...segments]
        .reverse()
        .slice(0, segmentDrops.length)
        .map((s) => s.id),
    );
  });
});

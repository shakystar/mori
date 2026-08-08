import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, nowIso } from "../../src/domain/common.js";
import { createProject } from "../../src/domain/entities.js";
import { renderMemoryContext } from "../../src/services/context-render.js";
import { buildMemoryContext } from "../../src/services/context-service.js";
import { INJECTION_BUDGET_TOKENS } from "../../src/services/injection-budget.js";
import {
  retrieveMemoryContext,
  retrieveSegments,
} from "../../src/services/memory-retrieval-service.js";
import { rebuildProjectProjection } from "../../src/services/projection-store.js";
import { estimateTokens } from "../../src/services/token-estimate.js";
import { closeAll, getDb } from "../../src/storage/db.js";
import { appendEvent } from "../../src/storage/event-store.js";

/**
 * #238 — the canonical injection ceiling, enforced over the RENDERED block.
 *
 * These cases go through `buildMemoryContext` rather than the trim function
 * directly, because what is under test is that the ceiling holds for what the
 * kernel actually hands a harness: each channel is pre-trimmed by its own char
 * budget during retrieval, and the claim is about what survives the whole path.
 *
 * The un-budgeted retrieval (`retrieveMemoryContext` / `retrieveSegments`) is
 * called alongside as the BASELINE — what would have been injected before the
 * ceiling existed — so the drop-order case can say "segments were cut and the
 * pool was not" without hard-coding counts that a ranking tweak would
 * invalidate.
 */
let sandbox: string;
let projectId: string;
const TASK = "zephyr deploy runbook";

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-injection-budget-"));
  process.env.MEMORIZE_ROOT = sandbox;

  const project = createProject({ title: "budget", rootPath: "/tmp/budget" });
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

async function seedMemory(id: string, text: string, salience: number): Promise<void> {
  await appendEvent({
    type: "memory.consolidated",
    projectId,
    scopeType: "project",
    scopeId: projectId,
    actor: "test",
    payload: {
      id,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      projectId,
      kind: "insight",
      text,
      salience,
      sourceObservationIds: [],
    } as never,
  });
}

async function seedObservation(id: string, summary: string): Promise<void> {
  await appendEvent({
    type: "observation.captured",
    projectId,
    scopeType: "project",
    scopeId: projectId,
    actor: "test",
    payload: {
      id,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      projectId,
      signal: "decision-keyword",
      toolName: "bash",
      summary,
    } as never,
  });
}

function insertSegment(id: string, text: string): void {
  getDb(projectId)
    .prepare(
      "INSERT INTO segments (id, session_id, created_at, ordinal, source, text) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, "s1", nowIso(), 0, null, text);
}

/** Exactly `chars` characters of text that matches the task title's FTS terms. */
function filler(chars: number): string {
  const unit = "zephyr deploy runbook detail ";
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

/**
 * Every channel filled past what it can inject: the memory/observation pool and
 * the segment channel both overflow their retrieval budgets, so what reaches
 * the ceiling is each channel's own maximum.
 */
async function seedOverBudgetCorpus(): Promise<void> {
  for (let i = 0; i < 14; i++) {
    // Descending salience gives the pool a deterministic top entry.
    await seedMemory(`mem_${i}`, `memory ${i}: ${filler(170)}`, 10 - Math.floor(i / 2));
  }
  for (let i = 0; i < 12; i++) {
    await seedObservation(`obs_${i}`, `observation ${i}: ${filler(120)}`);
  }
  for (let i = 0; i < 6; i++) {
    insertSegment(`seg_${i}`, `USER: ${filler(150)}\n\nAGENT: ${filler(150)}`);
  }
  await rebuildProjectProjection(projectId, { reindexSearch: true });
}

describe("injection budget", () => {
  it("keeps the rendered block within the canonical ceiling when every channel overflows", async () => {
    await seedOverBudgetCorpus();

    const { context } = await buildMemoryContext(projectId, { taskTitle: TASK });

    // Measured on the rendered string — header, section titles, item prefixes
    // and segment fences included — not on the sum of the stored texts under it.
    // That this corpus really does overflow (rather than passing for free) is
    // what the drop-order case below asserts on the same seed.
    expect(estimateTokens(renderMemoryContext(context).length)).toBeLessThanOrEqual(
      INJECTION_BUDGET_TOKENS,
    );
  });

  it("drops segments before the pool, keeping the top-ranked consolidated memory", async () => {
    await seedOverBudgetCorpus();

    const baselinePool = retrieveMemoryContext(projectId, { taskTitle: TASK });
    const baselineSegments = await retrieveSegments(projectId, { taskTitle: TASK });
    const { context, dropped } = await buildMemoryContext(projectId, { taskTitle: TASK });

    // Segments — verbatim transcript, usually already distilled into a memory —
    // are where the overflow is taken from.
    expect(baselineSegments.length).toBeGreaterThan(0);
    expect(context.rawSegments?.length ?? 0).toBeLessThan(baselineSegments.length);
    // …and taken from them FIRST: nothing the pool ranked was dropped.
    expect(
      (context.consolidatedMemories?.length ?? 0) + (context.recentObservations?.length ?? 0),
    ).toBe(baselinePool.ranked.length);
    expect(context.consolidatedMemories?.map((m) => m.id)).toContain(
      baselinePool.memories[0]!.memory.id,
    );
    // #242 1/2 — the same priority shows up in the recorded drop order: every
    // dropped segment was cut before any dropped pool entry.
    const segmentDrops = dropped.filter((d) => d.channel === "segment");
    const poolDrops = dropped.filter((d) => d.channel !== "segment");
    expect(segmentDrops.length).toBeGreaterThan(0);
    expect(poolDrops).toHaveLength(0);
  });

  it("injects all three channels untouched when the corpus fits", async () => {
    await seedMemory("mem_fit", `chose zephyr as the deploy target: ${filler(60)}`, 9);
    await seedObservation("obs_fit", `ran the deploy runbook: ${filler(60)}`);
    insertSegment("seg_fit", `USER: why zephyr?\n\nAGENT: ${filler(60)}`);
    await rebuildProjectProjection(projectId, { reindexSearch: true });

    const { context, dropped } = await buildMemoryContext(projectId, { taskTitle: TASK });

    // Trimming must be the exception, not a standing tax that quietly shrinks
    // every injection.
    expect(context.consolidatedMemories?.map((m) => m.id)).toEqual(["mem_fit"]);
    expect(context.recentObservations?.map((o) => o.summary)).toHaveLength(1);
    expect(context.rawSegments?.map((s) => s.id)).toEqual(["seg_fit"]);
    expect(dropped).toEqual([]);
  });
});

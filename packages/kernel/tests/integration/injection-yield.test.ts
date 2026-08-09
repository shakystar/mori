import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, nowIso } from "../../src/domain/common.js";
import { createProject } from "../../src/domain/entities.js";
import type { MemoryInjectedPayload } from "../../src/domain/entities/memory.js";
import {
  SqliteMemoryKernel,
  type ObservedToolCall,
} from "../../src/kernel/sqlite-memory-kernel.js";
import { renderMemoryContext } from "../../src/services/context-render.js";
import { ageBuckets, buildInjectionYieldReport } from "../../src/services/injection-yield.js";
import { RECENCY_HALF_LIFE_DAYS } from "../../src/services/memory-retrieval-service.js";
import { rebuildProjectProjection } from "../../src/services/projection-store.js";
import { closeAll, getDb } from "../../src/storage/db.js";
import { appendEvent, readEvents } from "../../src/storage/event-store.js";

/**
 * The judgement `injection-yield.ts` defines — see
 * docs/injection-yield-vocabulary.md for why re-selection is the proxy and
 * where it is wrong.
 */
let sandbox: string;
let projectId: string;
const NOW = "2026-06-15T00:00:00.000Z";
/** Matches the filler text below, so the FTS/ranking path actually returns it. */
const TASK = "zephyr deploy runbook";

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

async function seedMemory(
  id: string,
  createdAt: string = NOW,
  text: string = `memory ${id}`,
  salience = 5,
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

/** Exactly `chars` characters of text that matches {@link TASK}'s FTS terms. */
function filler(chars: number): string {
  const unit = "zephyr deploy runbook detail ";
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

/**
 * Every channel filled past what it can inject — the same shape
 * `injection-budget.test.ts`'s `seedOverBudgetCorpus` uses, because the drop
 * facts under test are the ones that trim produces.
 */
async function seedOverBudgetCorpus(): Promise<void> {
  for (let i = 0; i < 14; i++) {
    await seedMemory(`mem_${i}`, NOW, `memory ${i}: ${filler(170)}`, 10 - Math.floor(i / 2));
  }
  for (let i = 0; i < 12; i++) {
    await seedObservation(`obs_${i}`, `observation ${i}: ${filler(120)}`);
  }
  for (let i = 0; i < 6; i++) {
    insertSegment(`seg_${i}`, `USER: ${filler(150)}\n\nAGENT: ${filler(150)}`);
  }
  await rebuildProjectProjection(projectId, { reindexSearch: true });
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

  it("reports the entries the budget cut in the same report as the three-way judgement", async () => {
    await seedOverBudgetCorpus();

    // Through the REAL injection path, not `fitInjectionBudget` directly: what
    // this asserts is the wiring — that the kernel puts the trim on the event
    // it appends, and that this module reads it back off. Calling the trim
    // function here would skip both halves of that.
    const kernel = new SqliteMemoryKernel<string, ObservedToolCall>({
      projectId,
      actor: "test",
      sessionId: "sess_kernel",
      project: { title: "yield", rootPath: sandbox },
      observeEvent: (event) => event,
      renderContext: renderMemoryContext,
      readQuery: () => ({ query: TASK, turnId: "turn_1" }),
    });
    expect(await kernel.transformContext(["one"])).toHaveLength(2);

    // (a) the corpus really did overflow, and the kernel recorded what it cut.
    const injected = (await readEvents(projectId)).filter(
      (event) => event.type === "memory.injected",
    );
    expect(
      injected.some((event) => ((event.payload as MemoryInjectedPayload).dropped?.length ?? 0) > 0),
    ).toBe(true);

    // (b) …and both axes come out of one report, which is the point: "raise the
    // budget or fix the ranking?" needs the drop list and the classes together.
    const report = await buildInjectionYieldReport(projectId, { nowIso: NOW });
    expect(report.budgetPressure.turnsWithDrops).toBeGreaterThan(0);
    expect(report.budgetPressure.totalInjections).toBeGreaterThanOrEqual(
      report.budgetPressure.turnsWithDrops,
    );
    expect(report.longTerm.counts["injected-once"]).toBeGreaterThan(0);
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

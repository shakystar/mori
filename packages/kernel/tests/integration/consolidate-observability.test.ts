import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createObservation, createProject } from "../../src/domain/entities.js";
import {
  buildLifecycleEvidenceReport,
  consolidate,
  getConsolidationStatus,
  type Consolidator,
  type ExtractedMemory,
} from "../../src/services/consolidate-service.js";
import { listValidMemories } from "../../src/services/projection-store.js";
import { closeAll } from "../../src/storage/db.js";
import { appendEvent } from "../../src/storage/event-store.js";

let sandbox: string;
let projectId: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-consolidate-obs-"));
  process.env.MEMORIZE_ROOT = sandbox;

  const project = createProject({ title: "observability", rootPath: join(sandbox, "p") });
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

async function seedObservation(summary: string): Promise<void> {
  await appendEvent({
    type: "observation.captured",
    projectId,
    scopeType: "session",
    scopeId: projectId,
    actor: "test",
    payload: createObservation({
      projectId,
      signal: "decision-keyword",
      summary,
      toolName: "Bash",
    }),
  });
}

/** Extractor that emits exactly the given items, once. */
function emitting(items: ExtractedMemory[]): Consolidator {
  return {
    async extract() {
      return items;
    },
  };
}

describe("getConsolidationStatus", () => {
  it("reports an empty store as zero pending with no attempt", () => {
    expect(getConsolidationStatus(projectId)).toEqual({ pendingObservations: 0 });
  });

  it("counts observations past the watermark and dates the oldest", async () => {
    await seedObservation("first");
    await seedObservation("second");

    const status = getConsolidationStatus(projectId);
    expect(status.pendingObservations).toBe(2);
    expect(status.oldestPendingAt).toBeDefined();
    expect(Number.isNaN(Date.parse(status.oldestPendingAt!))).toBe(false);
    expect(status.lastAttempt).toBeUndefined();
  });

  it("drains the backlog after a boundary and carries the attempt record", async () => {
    await seedObservation("first");
    await consolidate({ projectId, actor: "test", boundary: "threshold" });

    const status = getConsolidationStatus(projectId);
    expect(status.pendingObservations).toBe(0);
    expect(status.oldestPendingAt).toBeUndefined();
    expect(status.lastAttempt).toMatchObject({ boundary: "threshold", outcome: "ok" });
  });

  it("counts only observation events, not every event past the watermark", async () => {
    await seedObservation("first");
    await appendEvent({
      type: "session.heartbeat",
      projectId,
      scopeType: "session",
      scopeId: projectId,
      actor: "test",
      payload: { sessionId: projectId, at: new Date().toISOString() },
    });

    expect(getConsolidationStatus(projectId).pendingObservations).toBe(1);
  });

  it("answers 'why are there no memories' after a failed boundary", async () => {
    await seedObservation("first");
    await expect(
      consolidate({
        projectId,
        actor: "test",
        consolidator: {
          async extract() {
            throw new Error("extractor unavailable");
          },
        },
      }),
    ).rejects.toThrow();

    const status = getConsolidationStatus(projectId);
    // The window is still pending AND the reason is recorded — the two facts
    // that separate "never ran" from "ran and failed".
    expect(status.pendingObservations).toBe(1);
    expect(status.lastAttempt).toMatchObject({
      outcome: "error",
      error: "extractor unavailable",
    });
    expect(listValidMemories(projectId)).toHaveLength(0);
  });
});

describe("buildLifecycleEvidenceReport", () => {
  it("is empty for a store with no memories", () => {
    expect(buildLifecycleEvidenceReport(projectId)).toEqual({
      memories: 0,
      byKind: {},
      obsoleteWhen: [],
      kindMisfitReasons: [],
    });
  });

  it("aggregates #57 evidence per kind, verbatim", async () => {
    await seedObservation("first");
    await consolidate({
      projectId,
      actor: "test",
      consolidator: emitting([
        {
          kind: "decision",
          text: "pin node 22",
          salience: 8,
          obsoleteWhen: "node 24 becomes LTS",
          tags: ["runtime", "ci"],
        },
        {
          kind: "decision",
          text: "use pnpm",
          salience: 7,
          tags: ["ci"],
        },
        {
          kind: "progress",
          text: "the kernel port is half done",
          salience: 5,
          kindMisfit: true,
          kindMisfitReason: "this is really a status, not progress on work",
        },
      ]),
    });

    const report = buildLifecycleEvidenceReport(projectId);
    expect(report.memories).toBe(3);
    expect(report.byKind.decision).toEqual({
      count: 2,
      withObsoleteWhen: 1,
      kindMisfit: 0,
      tags: { runtime: 1, ci: 2 },
    });
    expect(report.byKind.progress).toEqual({
      count: 1,
      withObsoleteWhen: 0,
      kindMisfit: 1,
      tags: {},
    });
    expect(report.obsoleteWhen).toEqual([{ kind: "decision", condition: "node 24 becomes LTS" }]);
    expect(report.kindMisfitReasons).toEqual([
      {
        kind: "progress",
        reason: "this is really a status, not progress on work",
        text: "the kernel port is half done",
      },
    ]);
  });

  it("includes invalidated memories — evidence is about how memories LIVED", async () => {
    await seedObservation("first");
    await consolidate({
      projectId,
      actor: "test",
      consolidator: emitting([{ kind: "decision", text: "old truth", salience: 7 }]),
    });
    const oldId = listValidMemories(projectId)[0]!.memory.id;

    await seedObservation("second");
    await consolidate({
      projectId,
      actor: "test",
      consolidator: emitting([
        { kind: "decision", text: "new truth", salience: 7, supersedesMemoryId: oldId },
      ]),
    });

    expect(listValidMemories(projectId)).toHaveLength(1);
    expect(buildLifecycleEvidenceReport(projectId).memories).toBe(2);
    expect(buildLifecycleEvidenceReport(projectId).byKind.decision?.count).toBe(2);
  });
});

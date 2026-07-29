import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createObservation, createProject } from "../../src/domain/entities.js";
import {
  consolidate,
  consolidateThreshold,
  shouldTriggerThresholdConsolidate,
} from "../../src/services/consolidate-service.js";
import { closeAll } from "../../src/storage/db.js";
import { appendEvent } from "../../src/storage/event-store.js";

let sandbox: string;
let projectId: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-threshold-consolidate-"));
  process.env.MEMORIZE_ROOT = sandbox;

  const project = createProject({ title: "threshold", rootPath: join(sandbox, "p") });
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
  delete process.env.MEMORIZE_CONSOLIDATE_THRESHOLD;
  await rm(sandbox, { recursive: true, force: true });
});

async function seedObservations(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await appendEvent({
      type: "observation.captured",
      projectId,
      scopeType: "session",
      scopeId: projectId,
      actor: "test",
      payload: createObservation({
        projectId,
        signal: "decision-keyword",
        summary: `decided step ${i}`,
        toolName: "Bash",
      }),
    });
  }
}

describe("consolidateThreshold", () => {
  it("defaults to 20 when unset or empty", () => {
    expect(consolidateThreshold({})).toBe(20);
    expect(consolidateThreshold({ MEMORIZE_CONSOLIDATE_THRESHOLD: "" })).toBe(20);
  });

  it("accepts a non-negative integer, including 0 (disabled)", () => {
    expect(consolidateThreshold({ MEMORIZE_CONSOLIDATE_THRESHOLD: "3" })).toBe(3);
    expect(consolidateThreshold({ MEMORIZE_CONSOLIDATE_THRESHOLD: "0" })).toBe(0);
  });

  it("falls back to the default for anything that is not a non-negative integer", () => {
    for (const raw of ["-1", "2.5", "abc", "1e3px"]) {
      expect(consolidateThreshold({ MEMORIZE_CONSOLIDATE_THRESHOLD: raw })).toBe(20);
    }
  });

  it("reads a whitespace-only value as 0 (disabled), like any other numeric coercion", () => {
    // `Number(" ")` is 0, which IS a non-negative integer — inherited verbatim
    // from the original so an operator's existing setting keeps its meaning.
    expect(consolidateThreshold({ MEMORIZE_CONSOLIDATE_THRESHOLD: " " })).toBe(0);
  });
});

describe("shouldTriggerThresholdConsolidate", () => {
  it("does not fire below the threshold", async () => {
    process.env.MEMORIZE_CONSOLIDATE_THRESHOLD = "3";
    await seedObservations(2);
    expect(shouldTriggerThresholdConsolidate(projectId)).toBe(false);
  });

  it("fires once the backlog reaches the threshold", async () => {
    process.env.MEMORIZE_CONSOLIDATE_THRESHOLD = "3";
    await seedObservations(3);
    expect(shouldTriggerThresholdConsolidate(projectId)).toBe(true);
  });

  it("never fires when the threshold is 0", async () => {
    process.env.MEMORIZE_CONSOLIDATE_THRESHOLD = "0";
    await seedObservations(50);
    expect(shouldTriggerThresholdConsolidate(projectId)).toBe(false);
  });

  it("debounces a second fire at the same watermark inside the TTL", async () => {
    process.env.MEMORIZE_CONSOLIDATE_THRESHOLD = "3";
    await seedObservations(3);
    const at = new Date("2026-07-29T00:00:00.000Z");

    expect(shouldTriggerThresholdConsolidate(projectId, at)).toBe(true);
    expect(shouldTriggerThresholdConsolidate(projectId, new Date(at.getTime() + 60_000))).toBe(
      false,
    );
  });

  it("re-arms after the TTL, so one dead run cannot mute the boundary forever", async () => {
    process.env.MEMORIZE_CONSOLIDATE_THRESHOLD = "3";
    await seedObservations(3);
    const at = new Date("2026-07-29T00:00:00.000Z");

    expect(shouldTriggerThresholdConsolidate(projectId, at)).toBe(true);
    expect(
      shouldTriggerThresholdConsolidate(projectId, new Date(at.getTime() + 5 * 60_000 + 1)),
    ).toBe(true);
  });

  it("re-arms immediately once the watermark advances", async () => {
    process.env.MEMORIZE_CONSOLIDATE_THRESHOLD = "3";
    await seedObservations(3);
    const at = new Date("2026-07-29T00:00:00.000Z");

    expect(shouldTriggerThresholdConsolidate(projectId, at)).toBe(true);

    // A successful boundary consumes the window and moves the watermark...
    await consolidate({ projectId, actor: "test", boundary: "threshold" });
    expect(shouldTriggerThresholdConsolidate(projectId, at)).toBe(false); // backlog drained

    // ...so the next backlog fires again inside the old TTL window.
    await seedObservations(3);
    expect(shouldTriggerThresholdConsolidate(projectId, new Date(at.getTime() + 1000))).toBe(true);
  });
});

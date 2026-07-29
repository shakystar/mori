import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createObservation, createProject } from "../../src/domain/entities.js";
import type { ConsolidatorLlm } from "../../src/index.js";
import {
  ExtractionParseError,
  classifyConsolidateError,
  consolidate,
  getConsolidateWatermark,
  readLastConsolidateAttempt,
  type Consolidator,
} from "../../src/services/consolidate-service.js";
import { closeAll } from "../../src/storage/db.js";
import { appendEvent } from "../../src/storage/event-store.js";

let sandbox: string;
let projectId: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-consolidate-attempt-"));
  process.env.MEMORIZE_ROOT = sandbox;

  const project = createProject({ title: "attempt", rootPath: join(sandbox, "p") });
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

/** A consolidator whose extract() always rejects with `error`. */
function failingWith(error: unknown): Consolidator {
  return {
    async extract() {
      throw error;
    },
  };
}

describe("classifyConsolidateError", () => {
  it("maps an unparseable extractor reply to parse-error", () => {
    expect(classifyConsolidateError(new ExtractionParseError("no array"))).toBe("parse-error");
  });

  it("maps a TimeoutError (or a message that says so) to timeout", () => {
    const aborted = new Error("The operation was aborted");
    aborted.name = "TimeoutError";
    expect(classifyConsolidateError(aborted)).toBe("timeout");
    expect(classifyConsolidateError(new Error("extractor timed out after 20000ms"))).toBe(
      "timeout",
    );
  });

  it("maps a transport status message to http-error", () => {
    expect(classifyConsolidateError(new Error("LLM extractor HTTP 503"))).toBe("http-error");
  });

  it("falls back to error for anything else, including non-Errors", () => {
    expect(classifyConsolidateError(new Error("boom"))).toBe("error");
    expect(classifyConsolidateError("a bare string")).toBe("error");
  });
});

describe("consolidate — attempt telemetry", () => {
  it("has no attempt record before the first boundary", () => {
    expect(readLastConsolidateAttempt(projectId)).toBeUndefined();
  });

  it("records a successful attempt with the backend, boundary, and counts", async () => {
    await seedObservation("decided to ship");
    await seedObservation("decided to revert");

    await consolidate({ projectId, actor: "test", boundary: "session-end" });

    const attempt = readLastConsolidateAttempt(projectId);
    expect(attempt).toMatchObject({
      boundary: "session-end",
      backend: "rule-based",
      outcome: "ok",
      pendingObservations: 2,
      consolidated: 2,
    });
    expect(attempt?.error).toBeUndefined();
    expect(attempt?.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(attempt!.at))).toBe(false);
  });

  it("records a noop attempt for an empty window and defaults the boundary to manual", async () => {
    await consolidate({ projectId, actor: "test" });

    expect(readLastConsolidateAttempt(projectId)).toMatchObject({
      boundary: "manual",
      outcome: "noop",
      pendingObservations: 0,
    });
    expect(readLastConsolidateAttempt(projectId)?.consolidated).toBeUndefined();
  });

  it("records parse-error and keeps the window for the next boundary", async () => {
    await seedObservation("decided to ship");
    const llm: ConsolidatorLlm = {
      async complete() {
        return "I'm afraid I can't do that.";
      },
    };

    await expect(
      consolidate({ projectId, actor: "test", llm, boundary: "post-compact" }),
    ).rejects.toBeInstanceOf(ExtractionParseError);

    expect(readLastConsolidateAttempt(projectId)).toMatchObject({
      boundary: "post-compact",
      backend: "llm",
      outcome: "parse-error",
      pendingObservations: 1,
      error: "LLM reply contains no JSON array",
    });
    // The failure must not consume the window.
    expect(getConsolidateWatermark(projectId)).toBeUndefined();
  });

  it("records timeout and http-error from the injected client's own failures", async () => {
    await seedObservation("decided to ship");

    const timeout = new Error("The operation was aborted");
    timeout.name = "TimeoutError";
    await expect(
      consolidate({ projectId, actor: "test", consolidator: failingWith(timeout) }),
    ).rejects.toThrow();
    expect(readLastConsolidateAttempt(projectId)).toMatchObject({
      outcome: "timeout",
      backend: "custom",
    });

    await expect(
      consolidate({
        projectId,
        actor: "test",
        consolidator: failingWith(new Error("provider HTTP 429")),
      }),
    ).rejects.toThrow();
    expect(readLastConsolidateAttempt(projectId)).toMatchObject({ outcome: "http-error" });
  });

  it("truncates a long failure message", async () => {
    await seedObservation("decided to ship");
    await expect(
      consolidate({
        projectId,
        actor: "test",
        consolidator: failingWith(new Error("x".repeat(1000))),
      }),
    ).rejects.toThrow();

    expect(readLastConsolidateAttempt(projectId)?.error).toHaveLength(300);
  });

  it("overwrites the previous attempt rather than accumulating history", async () => {
    await seedObservation("decided to ship");
    await expect(
      consolidate({ projectId, actor: "test", consolidator: failingWith(new Error("boom")) }),
    ).rejects.toThrow();
    expect(readLastConsolidateAttempt(projectId)?.outcome).toBe("error");

    await consolidate({ projectId, actor: "test" });
    expect(readLastConsolidateAttempt(projectId)).toMatchObject({ outcome: "ok", consolidated: 1 });
  });
});

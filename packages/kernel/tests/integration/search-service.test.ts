import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHandoff, createProject, createTask } from "../../src/domain/entities.js";
import { rebuildProjectProjection } from "../../src/services/projection-store.js";
import { searchProject, toFtsMatch } from "../../src/services/search-service.js";
import { closeAll, getDb } from "../../src/storage/db.js";
import { appendEvent } from "../../src/storage/event-store.js";

/**
 * The upstream memorize version of this suite also drives fixtures through
 * task-service/migrate-service and covers a CLI smoke path — task-service and
 * migrate-service are out-of-kernel-scope (#62 body), and there is no kernel
 * CLI. This drives the same shapes directly through the domain factories +
 * appendEvent instead, matching the pattern already established for
 * projection-column-consistency.test.ts / projection-lane.test.ts.
 */
let sandbox: string;
let projectId: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-search-"));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

async function seedProject(): Promise<string> {
  const project = createProject({ title: "Search", rootPath: "/tmp/search" });
  await appendEvent({
    type: "project.created",
    projectId: project.id,
    scopeType: "project",
    scopeId: project.id,
    actor: "test",
    payload: project,
  });
  await rebuildProjectProjection(project.id);
  return project.id;
}

describe("search (FTS5)", () => {
  beforeEach(async () => {
    projectId = await seedProject();
  });

  it("creates the search_fts virtual table at user_version >= 4", () => {
    const db = getDb(projectId);
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(4);
    const row = db.prepare("SELECT name FROM sqlite_master WHERE name = 'search_fts'").get() as
      { name: string } | undefined;
    expect(row?.name).toBe("search_fts");
  });

  it("returns a created task ranked for a known word", async () => {
    const task = createTask({
      projectId,
      title: "Implement quokka migration pipeline",
      description: "A distinctive marsupial keyword: quokka",
    });
    await appendEvent({
      type: "task.created",
      projectId,
      scopeType: "task",
      scopeId: task.id,
      actor: "test",
      payload: task,
    });
    await rebuildProjectProjection(projectId);

    const hits = searchProject(projectId, "quokka");
    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0]!;
    expect(top.entityId).toBe(task.id);
    expect(top.kind).toBe("task");
    expect(top.snippet).toContain("[quokka]");
    expect(typeof top.score).toBe("number");
  });

  it("finds a handoff by its summary text", async () => {
    const task = createTask({ projectId, title: "Carrier task" });
    await appendEvent({
      type: "task.created",
      projectId,
      scopeType: "task",
      scopeId: task.id,
      actor: "test",
      payload: task,
    });
    const handoff = createHandoff({
      projectId,
      taskId: task.id,
      fromActor: "a",
      toActor: "b",
      summary: "Investigated the platypus deadlock thoroughly",
      nextAction: "continue",
    });
    await appendEvent({
      type: "handoff.created",
      projectId,
      scopeType: "task",
      scopeId: task.id,
      actor: "a",
      payload: handoff,
    });
    await rebuildProjectProjection(projectId);

    const hits = searchProject(projectId, "platypus");
    expect(hits.some((h) => h.entityId === handoff.id && h.kind === "handoff")).toBe(true);
  });

  it("returns nothing for an absent term", async () => {
    const task = createTask({ projectId, title: "ordinary work" });
    await appendEvent({
      type: "task.created",
      projectId,
      scopeType: "task",
      scopeId: task.id,
      actor: "test",
      payload: task,
    });
    await rebuildProjectProjection(projectId);

    expect(searchProject(projectId, "zzzznonexistentterm")).toEqual([]);
  });

  it("does not crash on punctuation-only or empty queries", async () => {
    const task = createTask({ projectId, title: "something" });
    await appendEvent({
      type: "task.created",
      projectId,
      scopeType: "task",
      scopeId: task.id,
      actor: "test",
      payload: task,
    });
    await rebuildProjectProjection(projectId);

    expect(searchProject(projectId, "")).toEqual([]);
    expect(searchProject(projectId, "   ")).toEqual([]);
    expect(searchProject(projectId, "!!! ??? ***")).toEqual([]);
    // Punctuation mixed with a real token must not throw and should match.
    expect(() => searchProject(projectId, "some-thing! (else)")).not.toThrow();
  });

  it("toFtsMatch OR-joins tokens and rejects content-free queries", () => {
    expect(toFtsMatch("hello world")).toBe('"hello" OR "world"');
    // Embedded double-quotes are doubled (FTS5 string escaping).
    expect(toFtsMatch('say "hi"')).toBe('"say" OR """hi"""');
    expect(toFtsMatch("   ")).toBeUndefined();
    expect(toFtsMatch("!!!")).toBeUndefined();
  });

  it("matches a document that contains only SOME of a multi-word query (OR, not AND)", async () => {
    const task = createTask({
      projectId,
      title: "Quokka habitat notes",
      description: "A distinctive marsupial keyword: quokka",
    });
    await appendEvent({
      type: "task.created",
      projectId,
      scopeType: "task",
      scopeId: task.id,
      actor: "test",
      payload: task,
    });
    await rebuildProjectProjection(projectId);

    // The query has words that do NOT all appear in the task; under an
    // AND-join this would return nothing. OR-join must still surface the task.
    const hits = searchProject(projectId, "where does the quokka sleep at night");
    expect(hits.some((h) => h.entityId === task.id)).toBe(true);
  });
});

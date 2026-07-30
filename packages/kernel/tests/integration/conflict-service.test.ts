import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConflict, createProject } from "../../src/domain/entities.js";
import { MemorizeError } from "../../src/shared/errors.js";
import {
  readConflict,
  resolveConflict,
  type ResolveConflictParams,
} from "../../src/services/conflict-service.js";
import {
  getConflict,
  listOpenConflicts,
  rebuildProjectProjection,
} from "../../src/services/projection-store.js";
import { closeAll } from "../../src/storage/db.js";
import { appendEvent } from "../../src/storage/event-store.js";

let sandbox: string;
let projectId: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-conflict-svc-"));
  process.env.MEMORIZE_ROOT = sandbox;

  const project = createProject({ title: "conflict-svc", rootPath: join(sandbox, "p") });
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

async function seedConflict(): Promise<string> {
  const conflict = createConflict({
    projectId,
    scopeType: "rule",
    scopeId: projectId,
    fieldPath: "commit_style",
    leftVersion: "small_commits",
    rightVersion: "squash_final_commit",
    conflictType: "rule",
  });
  await appendEvent({
    type: "conflict.detected",
    projectId,
    scopeType: "project",
    scopeId: conflict.id,
    actor: "test",
    payload: conflict,
  });
  await rebuildProjectProjection(projectId);
  return conflict.id;
}

describe("conflict-service", () => {
  it("readConflict is a passthrough of the projection reader", async () => {
    const conflictId = await seedConflict();
    expect(readConflict(projectId, conflictId)).toEqual(getConflict(projectId, conflictId));
    expect(readConflict(projectId, "conflict_missing")).toBeUndefined();
  });

  it("resolveConflict transitions status, stamps resolvedAt/resolvedBy, and rebuilds", async () => {
    const conflictId = await seedConflict();

    const resolved = await resolveConflict({
      projectId,
      conflictId,
      status: "resolved",
      resolutionSummary: "Picked squash-final-commit as the house style",
      resolvedBy: "owner",
      actor: "test",
    });

    expect(resolved.status).toBe("resolved");
    expect(resolved.resolutionSummary).toBe("Picked squash-final-commit as the house style");
    expect(resolved.resolvedBy).toBe("owner");
    expect(resolved.resolvedAt).toBeDefined();

    const persisted = getConflict(projectId, conflictId);
    expect(persisted?.status).toBe("resolved");
    expect(listOpenConflicts(projectId).find((c) => c.id === conflictId)).toBeUndefined();
  });

  it("auto_resolved conflicts drop out of listOpenConflicts but stay readable (#118 item 2)", async () => {
    const conflictId = await seedConflict();

    const autoResolved = await resolveConflict({
      projectId,
      conflictId,
      status: "auto_resolved",
      actor: "test",
    });

    expect(autoResolved.status).toBe("auto_resolved");
    expect(autoResolved.resolvedAt).toBeDefined();
    expect(listOpenConflicts(projectId).find((c) => c.id === conflictId)).toBeUndefined();
    // invalidate-not-delete: still readable via readConflict/getConflict.
    expect(readConflict(projectId, conflictId)?.status).toBe("auto_resolved");
  });

  it("escalated conflicts stamp no resolvedAt (only resolved/auto_resolved do)", async () => {
    const conflictId = await seedConflict();
    const escalated = await resolveConflict({
      projectId,
      conflictId,
      status: "escalated",
      actor: "test",
    });
    expect(escalated.status).toBe("escalated");
    expect(escalated.resolvedAt).toBeUndefined();
    // escalated conflicts are still "open" (status != 'resolved')
    expect(listOpenConflicts(projectId).find((c) => c.id === conflictId)).toBeDefined();
  });

  it("rejects an invalid state transition (resolved -> escalated)", async () => {
    const conflictId = await seedConflict();
    await resolveConflict({ projectId, conflictId, status: "resolved", actor: "test" });

    await expect(
      resolveConflict({ projectId, conflictId, status: "escalated", actor: "test" }),
    ).rejects.toThrow(MemorizeError);
  });

  it("throws MemorizeError for an unknown conflict id", async () => {
    const params: ResolveConflictParams = {
      projectId,
      conflictId: "conflict_missing",
      status: "resolved",
      actor: "test",
    };
    await expect(resolveConflict(params)).rejects.toThrow(MemorizeError);
  });

  it("multiple conflicts in the same project each persist independently", async () => {
    const first = await seedConflict();
    const second = await seedConflict();
    expect(first).not.toBe(second);

    await resolveConflict({ projectId, conflictId: first, status: "resolved", actor: "test" });

    // The second conflict must still be readable/open — a scopeId collision
    // in the projector's in-memory reduce step would have dropped it.
    expect(getConflict(projectId, second)?.status).toBe("detected");
    expect(
      listOpenConflicts(projectId)
        .map((c) => c.id)
        .sort(),
    ).toEqual([second].sort());
  });
});

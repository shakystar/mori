/**
 * #253 (#189 A) — the interleave `expectedHead` exists for: two judgments read
 * the SAME log head, both decide, and the second one to reach the store must be
 * refused instead of quietly landing its verdict on a log that has moved.
 *
 * Deterministic by CONSTRUCTION rather than by seam injection, and that is a
 * stronger version of the same rule `kernel-capture-race.test.ts` follows (no
 * `sleep`, no timing): what makes a caller a loser here is not when it runs but
 * WHICH head it read, and a head is a plain value the test can hold. So both
 * "judgments" are set up by reading the head once, and the loser's append is
 * issued after the winner's — no clock, no mock, and no lie to any module,
 * which keeps this file out of TESTING.md's mock exception entirely.
 *
 * The store seam, not a service: the property under test is that the STORE
 * refuses, whatever the caller was judging. `contradiction-service.test.ts`
 * covers one adopted span end to end.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProject } from "../../src/domain/entities.js";
import { closeAll } from "../../src/storage/db.js";
import {
  appendEvent,
  appendEvents,
  isStaleHeadError,
  readEvents,
  readHeadEventId,
  type AppendEventInput,
} from "../../src/storage/event-store.js";

let sandbox: string;
let projectId: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-cas-append-"));
  process.env.MEMORIZE_ROOT = sandbox;

  const project = createProject({ title: "cas-append", rootPath: join(sandbox, "p") });
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

/** A one-event verdict batch, tagged so the log can be searched for it. */
function verdict(tag: string): AppendEventInput<never>[] {
  return [
    {
      type: "memory.superseded",
      projectId,
      scopeType: "project",
      scopeId: projectId,
      actor: "test",
      payload: { supersedes: `mem_${tag}`, supersededBy: `mem_by_${tag}`, reason: tag } as never,
    },
  ];
}

describe("compare-and-append under a two-judgment interleave", () => {
  it("refuses the second verdict written against a head both judgments read", async () => {
    // Both judgments read the basis — and therefore the head — at this point.
    const sharedHead = (await readHeadEventId(projectId)) ?? null;

    // Judgment A reaches the store first and wins.
    await appendEvents(projectId, verdict("winner"), { expectedHead: sharedHead });

    // Judgment B decided from the same head. It must NOT silently succeed.
    const rejection = await appendEvents(projectId, verdict("loser"), {
      expectedHead: sharedHead,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isStaleHeadError(rejection)).toBe(true);

    const reasons = (await readEvents(projectId))
      .filter((event) => event.type === "memory.superseded")
      .map((event) => (event.payload as { reason: string }).reason);
    expect(reasons).toEqual(["winner"]);
  });
});

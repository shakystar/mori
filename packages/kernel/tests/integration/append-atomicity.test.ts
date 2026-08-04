import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeAll } from "../../src/storage/db.js";
import {
  appendEvents,
  isStaleHeadError,
  readEvents,
  readHeadEventId,
} from "../../src/storage/event-store.js";

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "memorize-append-atomic-"));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe("appendEvents atomicity", () => {
  it("rolls back the whole batch when one event fails inside the transaction", async () => {
    // event-store has no dependency on the (out-of-scope, #11) project
    // service — a bare valid projectId is enough to address a per-project db.
    const projectId = "proj_atomic_test1";

    const before = (await readEvents(projectId)).length;

    // The second event carries a BigInt payload — JSON.stringify (inside
    // insertEvent) throws on BigInt, which aborts the db.transaction and
    // rolls back the first INSERT too.
    await expect(
      appendEvents(projectId, [
        {
          type: "task.created",
          projectId,
          scopeType: "task",
          scopeId: "task_ok",
          actor: "user",
          payload: { id: "task_ok" } as never,
        },
        {
          type: "task.created",
          projectId,
          scopeType: "task",
          scopeId: "task_bad",
          actor: "user",
          payload: { bad: 1n } as never,
        },
      ]),
    ).rejects.toThrow();

    // Full rollback: the event count is unchanged — neither the valid first
    // event nor the failing second event was persisted.
    const after = await readEvents(projectId);
    expect(after.length).toBe(before);
    expect(after.some((e) => e.scopeId === "task_ok")).toBe(false);
  });

  it("rejects the whole batch when expectedHead no longer matches the log head", async () => {
    // #253 (#189 A): the compare-and-append refusal is graded the same as the
    // rollback above — a batch that loses the race must leave NOTHING behind,
    // so this asserts on a 2-event batch rather than a single append.
    const projectId = "proj_atomic_test2";

    await appendEvents(projectId, [
      {
        type: "task.created",
        projectId,
        scopeType: "task",
        scopeId: "task_head",
        actor: "user",
        payload: { id: "task_head" } as never,
      },
    ]);
    const head = await readHeadEventId(projectId);
    const before = (await readEvents(projectId)).length;

    // A head that is NOT the current one — the state a caller is in when it
    // read its basis before somebody else appended.
    const staleHead = `${head}_superseded`;
    const rejection = await appendEvents(
      projectId,
      [
        {
          type: "task.created",
          projectId,
          scopeType: "task",
          scopeId: "task_stale_first",
          actor: "user",
          payload: { id: "task_stale_first" } as never,
        },
        {
          type: "task.created",
          projectId,
          scopeType: "task",
          scopeId: "task_stale_second",
          actor: "user",
          payload: { id: "task_stale_second" } as never,
        },
      ],
      { expectedHead: staleHead },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Narrowly identifiable as a lost race, not an opaque store failure — the
    // property `isDuplicateGenesisError` gives B's callers (#236).
    expect(isStaleHeadError(rejection)).toBe(true);

    const after = await readEvents(projectId);
    expect(after.length).toBe(before);
    expect(after.some((e) => e.scopeId === "task_stale_first")).toBe(false);
    expect(after.some((e) => e.scopeId === "task_stale_second")).toBe(false);
  });
});

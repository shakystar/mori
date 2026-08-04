import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeAll } from "../../src/storage/db.js";
import {
  appendEvent,
  isDuplicateGenesisError,
  readEvents,
} from "../../src/storage/event-store.js";
import { getProjectDbFile } from "../../src/storage/path-resolver.js";

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "memorize-evtstore-roundtrip-"));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

// #236 (#189 B) — db.ts v18's `idx_events_genesis_once` partial unique index,
// exercised directly at the event-store seam rather than through the kernel:
// `ensureGenesis`'s own check-then-append gap cannot be raced in a single
// process (better-sqlite3 is synchronous — see `kernel-project-lock.test.ts`),
// so this proves what the DATABASE does when two genesis inserts land for the
// same project_id, independent of how that ever happens above it.
describe("event-store project.created uniqueness (#236)", () => {
  function genesisInput(projectId: string) {
    return {
      type: "project.created" as const,
      projectId,
      scopeType: "project" as const,
      scopeId: projectId,
      actor: "test",
      payload: { id: projectId, title: "dup genesis" },
    };
  }

  it("rejects a second project.created for the same store, leaving exactly one row", async () => {
    const projectId = "proj_genesis_dup_01";

    await appendEvent(genesisInput(projectId));
    await expect(appendEvent(genesisInput(projectId))).rejects.toSatisfy(
      (error: unknown) => isDuplicateGenesisError(error),
    );

    const events = await readEvents(projectId);
    expect(events.filter((event) => event.type === "project.created")).toHaveLength(1);
  });
});

describe("event-store append -> read roundtrip (real sqlite file, not :memory:)", () => {
  it("writes to an on-disk .db file that outlives the writing connection", async () => {
    const projectId = "proj_roundtrip_01";

    const appended = await appendEvent({
      type: "task.created",
      projectId,
      scopeType: "task",
      scopeId: "task_roundtrip",
      actor: "test",
      payload: { title: "roundtrip" },
    });

    const dbFile = getProjectDbFile(projectId);
    expect(fs.existsSync(dbFile)).toBe(true);

    // Close the cached connection to force the next read to open the .db
    // file from scratch — proving persistence lives in the file itself, not
    // just in the still-open in-process handle.
    closeAll();

    const events = await readEvents(projectId);
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(appended.id);
    expect(events[0]?.payload).toEqual({ title: "roundtrip" });
  });
});

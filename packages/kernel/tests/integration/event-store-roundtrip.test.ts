import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeAll } from "../../src/storage/db.js";
import { appendEvent, readEvents } from "../../src/storage/event-store.js";
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

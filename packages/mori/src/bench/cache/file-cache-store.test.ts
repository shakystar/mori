import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLlmCallCacheStore, sweepOrphanCacheTmpFiles } from "./file-cache-store.js";

const MESSAGE: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "hi" }],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 0,
};

describe("FileLlmCallCacheStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mori-llm-cache-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns undefined for a key that was never written", async () => {
    const store = new FileLlmCallCacheStore(dir);
    expect(await store.get("missing-key")).toBeUndefined();
  });

  it("round-trips a stored message", async () => {
    const store = new FileLlmCallCacheStore(dir);
    await store.set("abc123", MESSAGE);
    expect(await store.get("abc123")).toEqual(MESSAGE);
  });

  it("creates the target directory on demand", async () => {
    const nested = join(dir, "nested", "cache", "dir");
    const store = new FileLlmCallCacheStore(nested);
    await store.set("key", MESSAGE);
    expect(await store.get("key")).toEqual(MESSAGE);
  });

  it("rejects a key that could escape dir instead of reading/writing outside it", async () => {
    const store = new FileLlmCallCacheStore(dir);
    await expect(store.set("../../../etc/passwd", MESSAGE)).rejects.toThrow(/invalid key/);
    await expect(store.get("../../../etc/passwd")).rejects.toThrow(/invalid key/);
  });
});

describe("sweepOrphanCacheTmpFiles", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mori-llm-cache-sweep-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Backdates a file's mtime past the sweep's young-orphan guard — standing in for "this
   * `.tmp-<uuid>` was left by a process that died a while ago", as opposed to one currently
   * mid-write. */
  async function ageFile(path: string, ageMs: number): Promise<void> {
    const past = new Date(Date.now() - ageMs);
    await utimes(path, past, past);
  }

  it("removes .tmp-<uuid> orphans left by a set() that died between write and rename", async () => {
    const orphan = join(dir, "abc123.json.tmp-9f2c1e4a-1111-4a11-8a11-000000000001");
    await writeFile(orphan, "{}");
    await ageFile(orphan, 120_000);
    await writeFile(join(dir, "abc123.json"), JSON.stringify(MESSAGE));

    const removed = await sweepOrphanCacheTmpFiles(dir);

    expect(removed).toBe(1);
    const remaining = await readdir(dir);
    expect(remaining).toEqual(["abc123.json"]);
  });

  it("leaves a very recent .tmp-<uuid> alone — it may still be mid-write", async () => {
    const orphan = join(dir, "abc123.json.tmp-9f2c1e4a-1111-4a11-8a11-000000000001");
    await writeFile(orphan, "{}");

    const removed = await sweepOrphanCacheTmpFiles(dir);

    expect(removed).toBe(0);
    expect(await readdir(dir)).toEqual(["abc123.json.tmp-9f2c1e4a-1111-4a11-8a11-000000000001"]);
  });

  it("is a no-op when dir has no orphans", async () => {
    await writeFile(join(dir, "abc123.json"), JSON.stringify(MESSAGE));
    expect(await sweepOrphanCacheTmpFiles(dir)).toBe(0);
  });

  it("does not error when dir does not exist yet", async () => {
    const missing = join(dir, "never-created");
    expect(await sweepOrphanCacheTmpFiles(missing)).toBe(0);
  });

  it("cleans up multiple aged orphans left by concurrent writers to different keys", async () => {
    await mkdir(dir, { recursive: true });
    const a = join(dir, "a.json.tmp-11111111-1111-4a11-8a11-000000000001");
    const b = join(dir, "b.json.tmp-22222222-1111-4a11-8a11-000000000002");
    await writeFile(a, "{}");
    await writeFile(b, "{}");
    await ageFile(a, 120_000);
    await ageFile(b, 120_000);

    expect(await sweepOrphanCacheTmpFiles(dir)).toBe(2);
    expect(await readdir(dir)).toEqual([]);
  });
});

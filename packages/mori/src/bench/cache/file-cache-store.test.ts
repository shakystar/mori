import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLlmCallCacheStore } from "./file-cache-store.js";

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

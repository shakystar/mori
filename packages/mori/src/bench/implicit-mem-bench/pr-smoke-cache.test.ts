import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { LlmCallCacheStore } from "../cache/llm-call-cache.js";
import { createFixtureCacheStreamFn, fixtureCacheKey } from "./pr-smoke-cache.js";

function model(): Model<Api> {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
}

function contextAt(timestamp: number): Context {
  return { messages: [{ role: "user", content: "hi", timestamp }] };
}

function inMemoryStore(): LlmCallCacheStore & { size(): number } {
  const map = new Map<string, AssistantMessage>();
  return {
    get: (key) => Promise.resolve(map.get(key)),
    set: (key, message) => {
      map.set(key, message);
      return Promise.resolve();
    },
    size: () => map.size,
  };
}

describe("fixtureCacheKey (#405)", () => {
  it(
    "is stable across different message timestamps — a real MoriSession turn stamps Date.now() " +
      "on every message (pi-agent-core), so hashing that raw would never replay across runs",
    () => {
      const keyA = fixtureCacheKey(model(), contextAt(1000));
      const keyB = fixtureCacheKey(model(), contextAt(2_000_000));
      expect(keyA).toBe(keyB);
    },
  );

  it("still differs when the message content actually differs", () => {
    const keyA = fixtureCacheKey(model(), contextAt(1000));
    const keyB = fixtureCacheKey(model(), {
      messages: [{ role: "user", content: "bye", timestamp: 1000 }],
    });
    expect(keyA).not.toBe(keyB);
  });
});

describe("createFixtureCacheStreamFn (#405)", () => {
  it(
    "counts a miss (and writes the fixture) on the first call, a hit on a repeat with a " +
      "different timestamp, and never calls a real provider either way",
    async () => {
      const store = inMemoryStore();
      const { streamFn, missCount, hitCount } = createFixtureCacheStreamFn(store);

      const first = await streamFn(model(), contextAt(1));
      const firstMessage = await first.result();
      expect(firstMessage.stopReason).toBe("stop");
      expect(missCount()).toBe(1);
      expect(hitCount()).toBe(0);
      expect(store.size()).toBe(1);

      const second = await streamFn(model(), contextAt(999_999_999));
      const secondMessage = await second.result();
      expect(secondMessage).toEqual(firstMessage);
      expect(missCount()).toBe(1);
      expect(hitCount()).toBe(1);
      expect(store.size()).toBe(1);
    },
  );

  it("misses again for a genuinely different context", async () => {
    const store = inMemoryStore();
    const { streamFn, missCount } = createFixtureCacheStreamFn(store);

    await streamFn(model(), contextAt(1));
    await streamFn(model(), {
      messages: [{ role: "user", content: "other prompt", timestamp: 1 }],
    });

    expect(missCount()).toBe(2);
  });
});

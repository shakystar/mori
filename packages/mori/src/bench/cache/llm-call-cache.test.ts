import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { beforeEach, describe, expect, it } from "vitest";
import { llmCallCacheKey, type LlmCallCacheStore, withLlmCallCache } from "./llm-call-cache.js";

const USAGE = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
};

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
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
    ...overrides,
  };
}

function context(overrides: Partial<Context> = {}): Context {
  return {
    systemPrompt: "You are a helpful bench reader.",
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
    ...overrides,
  };
}

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hi there" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: USAGE,
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

/** An in-memory `LlmCallCacheStore` — the real `FileLlmCallCacheStore` is covered separately
 * in file-cache-store.test.ts; these tests are about `withLlmCallCache`'s hit/miss behavior. */
class InMemoryStore implements LlmCallCacheStore {
  private readonly entries = new Map<string, AssistantMessage>();

  async get(key: string): Promise<AssistantMessage | undefined> {
    return this.entries.get(key);
  }

  async set(key: string, message: AssistantMessage): Promise<void> {
    this.entries.set(key, message);
  }
}

/** A `StreamFn` test double that counts real invocations and returns `responses` in order —
 * the completion condition's "fake provider call count" assertion reads this counter. */
function fakeStreamFn(
  first: AssistantMessage,
  ...rest: AssistantMessage[]
): StreamFn & { calls: number } {
  const responses = [first, ...rest];
  let calls = 0;
  const fn = async () => {
    const index = Math.min(calls, responses.length - 1);
    const message = responses[index] as AssistantMessage;
    calls += 1;
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    if (
      message.stopReason === "stop" ||
      message.stopReason === "length" ||
      message.stopReason === "toolUse"
    ) {
      stream.push({ type: "done", reason: message.stopReason, message });
    } else {
      stream.push({ type: "error", reason: message.stopReason, error: message });
    }
    stream.end(message);
    return stream;
  };
  Object.defineProperty(fn, "calls", { get: () => calls });
  return fn as unknown as StreamFn & { calls: number };
}

describe("withLlmCallCache", () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  it("misses on the first call, then replays on the second with zero provider calls", async () => {
    const response = assistantMessage();
    const inner = fakeStreamFn(response);
    const cached = withLlmCallCache(inner, store);

    const first = await cached(model(), context(), undefined);
    expect((await first.result()).content).toEqual(response.content);
    expect(inner.calls).toBe(1);

    const second = await cached(model(), context(), undefined);
    expect((await second.result()).content).toEqual(response.content);
    // Completion condition: replaying an identical key makes zero real provider calls.
    expect(inner.calls).toBe(1);
  });

  it("reports hit/miss through the optional hooks", async () => {
    const inner = fakeStreamFn(assistantMessage());
    const hits: string[] = [];
    const misses: string[] = [];
    const cached = withLlmCallCache(inner, store, {
      onHit: (key) => hits.push(key),
      onMiss: (key) => misses.push(key),
    });

    await (await cached(model(), context(), undefined)).result();
    await (await cached(model(), context(), undefined)).result();

    expect(misses).toHaveLength(1);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toBe(misses[0]);
  });

  it("misses again when the prompt differs", async () => {
    const inner = fakeStreamFn(assistantMessage());
    const cached = withLlmCallCache(inner, store);

    await cached(model(), context(), undefined);
    await cached(model(), context({ systemPrompt: "different prompt" }), undefined);

    expect(inner.calls).toBe(2);
  });

  it("misses again when a generation parameter differs", async () => {
    const inner = fakeStreamFn(assistantMessage());
    const cached = withLlmCallCache(inner, store);

    await cached(model(), context(), { temperature: 0.2 });
    await cached(model(), context(), { temperature: 0.9 });

    expect(inner.calls).toBe(2);
  });

  it("ignores non-generation options (e.g. apiKey, signal) when computing the key", async () => {
    const inner = fakeStreamFn(assistantMessage());
    const cached = withLlmCallCache(inner, store);

    await (await cached(model(), context(), { apiKey: "secret-a" })).result();
    await (
      await cached(model(), context(), { apiKey: "secret-b", signal: new AbortController().signal })
    ).result();

    // Only the generation-affecting params are keyed, so these collide into one call.
    expect(inner.calls).toBe(1);
  });

  it("still returns the provider's successful response when the store write fails", async () => {
    const response = assistantMessage();
    const inner = fakeStreamFn(response);
    const failingStore: LlmCallCacheStore = {
      get: async () => undefined,
      set: async () => {
        throw new Error("disk full");
      },
    };
    const storeErrors: Array<{ key: string; error: unknown }> = [];
    const cached = withLlmCallCache(inner, failingStore, {
      onStoreError: (key, error) => storeErrors.push({ key, error }),
    });

    const result = await (await cached(model(), context(), undefined)).result();

    expect(result.content).toEqual(response.content);
    expect(result.usage).toEqual(response.usage);
    expect(result.stopReason).toBe("stop");
    expect(storeErrors).toHaveLength(1);
  });

  it("still returns the provider's successful response when onHit throws", async () => {
    const response = assistantMessage();
    const inner = fakeStreamFn(response);
    const cached = withLlmCallCache(inner, store, {
      onHit: () => {
        throw new Error("onHit boom");
      },
    });

    await (await cached(model(), context(), undefined)).result();
    const second = await (await cached(model(), context(), undefined)).result();

    expect(second.content).toEqual(response.content);
    expect(second.usage).toEqual(response.usage);
    expect(second.stopReason).toBe("stop");
  });

  it("still returns the provider's successful response when onMiss throws", async () => {
    const response = assistantMessage();
    const inner = fakeStreamFn(response);
    const cached = withLlmCallCache(inner, store, {
      onMiss: () => {
        throw new Error("onMiss boom");
      },
    });

    const result = await (await cached(model(), context(), undefined)).result();

    expect(result.content).toEqual(response.content);
    expect(result.usage).toEqual(response.usage);
    expect(result.stopReason).toBe("stop");
  });

  it("still returns the provider's successful response when onStoreError throws", async () => {
    const response = assistantMessage();
    const inner = fakeStreamFn(response);
    const failingStore: LlmCallCacheStore = {
      get: async () => undefined,
      set: async () => {
        throw new Error("disk full");
      },
    };
    const cached = withLlmCallCache(inner, failingStore, {
      onStoreError: () => {
        throw new Error("onStoreError boom");
      },
    });

    const result = await (await cached(model(), context(), undefined)).result();

    expect(result.content).toEqual(response.content);
    expect(result.usage).toEqual(response.usage);
    expect(result.stopReason).toBe("stop");
  });

  it("does not cache an error terminal — the next call retries the provider", async () => {
    const errorMessage = assistantMessage({ stopReason: "error", errorMessage: "boom" });
    const inner = fakeStreamFn(errorMessage, assistantMessage());
    const cached = withLlmCallCache(inner, store);

    const first = await cached(model(), context(), undefined);
    expect((await first.result()).stopReason).toBe("error");

    const second = await cached(model(), context(), undefined);
    expect((await second.result()).stopReason).toBe("stop");
    expect(inner.calls).toBe(2);
  });
});

describe("llmCallCacheKey", () => {
  it("is stable across differently-ordered but equivalent option objects", () => {
    const a = llmCallCacheKey(model(), context(), { temperature: 0.5, maxTokens: 100 });
    const b = llmCallCacheKey(model(), context(), { maxTokens: 100, temperature: 0.5 });
    expect(a).toBe(b);
  });

  it("differs when the model id differs", () => {
    const a = llmCallCacheKey(model(), context());
    const b = llmCallCacheKey(model({ id: "claude-opus-4-6" }), context());
    expect(a).not.toBe(b);
  });
});

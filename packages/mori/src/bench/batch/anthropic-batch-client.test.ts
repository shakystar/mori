import type {
  BatchCreateParams,
  MessageBatch,
  MessageBatchIndividualResponse,
} from "@anthropic-ai/sdk/resources/messages/batches";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { llmCallCacheKey, type LlmCallCacheStore } from "../cache/llm-call-cache.js";
import {
  BatchTimeoutError,
  createAnthropicBatchClient,
  type AnthropicBatchesApi,
} from "./anthropic-batch-client.js";

/** An in-memory `LlmCallCacheStore` — the real `FileLlmCallCacheStore` is covered separately in
 * file-cache-store.test.ts; this test is about `runBatchCached`'s hit/miss orchestration. */
class InMemoryStore implements LlmCallCacheStore {
  private readonly entries = new Map<string, AssistantMessage>();
  readonly setCalls: string[] = [];

  async get(key: string): Promise<AssistantMessage | undefined> {
    return this.entries.get(key);
  }

  async set(key: string, message: AssistantMessage): Promise<void> {
    this.setCalls.push(key);
    this.entries.set(key, message);
  }
}

function model(): Model<Api> {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: false,
    input: ["text"],
    // $3/$15 per million tokens — nonzero so the 50% batch discount is observable in tests.
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
}

function pendingBatch(id: string): MessageBatch {
  return {
    id,
    archived_at: null,
    cancel_initiated_at: null,
    created_at: "2026-08-08T00:00:00Z",
    ended_at: null,
    expires_at: "2026-08-09T00:00:00Z",
    processing_status: "in_progress",
    request_counts: { canceled: 0, errored: 0, expired: 0, processing: 1, succeeded: 0 },
    results_url: null,
    type: "message_batch",
  };
}

function endedBatch(id: string): MessageBatch {
  return {
    ...pendingBatch(id),
    ended_at: "2026-08-08T01:00:00Z",
    processing_status: "ended",
    request_counts: { canceled: 0, errored: 0, expired: 0, processing: 0, succeeded: 1 },
    results_url: `https://api.anthropic.com/batches/${id}/results`,
  };
}

async function* asyncIterableOf<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

describe("createAnthropicBatchClient (#407)", () => {
  describe("submit", () => {
    it("maps each request onto a Message Batches create() request and returns the batch id", async () => {
      let created: BatchCreateParams | undefined;
      const batchesApi: AnthropicBatchesApi = {
        create: (body) => {
          created = body;
          return Promise.resolve(pendingBatch("batch_123"));
        },
        retrieve: () => Promise.reject(new Error("unused")),
        results: () => Promise.reject(new Error("unused")),
      };
      const client = createAnthropicBatchClient({ model: model(), batchesApi });

      const batchId = await client.submit([
        { customId: "a", prompt: "질문 A" },
        { customId: "b", prompt: "질문 B", systemPrompt: "너는 채점자다" },
      ]);

      expect(batchId).toBe("batch_123");
      expect(created?.requests).toHaveLength(2);
      expect(created?.requests[0]).toMatchObject({
        custom_id: "a",
        params: { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "질문 A" }] },
      });
      expect(created?.requests[0]?.params).not.toHaveProperty("system");
      expect(created?.requests[1]?.params).toMatchObject({ system: "너는 채점자다" });
    });

    it("rejects an empty request list instead of submitting a no-op batch", async () => {
      const batchesApi: AnthropicBatchesApi = {
        create: () => Promise.reject(new Error("create must not be called")),
        retrieve: () => Promise.reject(new Error("unused")),
        results: () => Promise.reject(new Error("unused")),
      };
      const client = createAnthropicBatchClient({ model: model(), batchesApi });

      await expect(client.submit([])).rejects.toThrow(/빈 요청 목록/);
    });
  });

  describe("pollUntilComplete", () => {
    it("polls retrieve() until processing_status is ended, sleeping between attempts", async () => {
      let retrieveCalls = 0;
      const sleepCalls: number[] = [];
      const batchesApi: AnthropicBatchesApi = {
        create: () => Promise.reject(new Error("unused")),
        retrieve: () => {
          retrieveCalls += 1;
          return Promise.resolve(retrieveCalls < 3 ? pendingBatch("b1") : endedBatch("b1"));
        },
        results: () => Promise.reject(new Error("unused")),
      };
      const client = createAnthropicBatchClient({
        model: model(),
        batchesApi,
        sleep: (ms) => {
          sleepCalls.push(ms);
          return Promise.resolve();
        },
        now: () => 0,
      });

      const batch = await client.pollUntilComplete("b1");

      expect(batch.processing_status).toBe("ended");
      expect(retrieveCalls).toBe(3);
      expect(sleepCalls).toHaveLength(2);
    });

    it("throws BatchTimeoutError carrying the batch id once elapsed time reaches the timeout", async () => {
      const batchesApi: AnthropicBatchesApi = {
        create: () => Promise.reject(new Error("unused")),
        retrieve: () => Promise.resolve(pendingBatch("b-stuck")),
        results: () => Promise.reject(new Error("unused")),
      };
      let clock = 0;
      const client = createAnthropicBatchClient({
        model: model(),
        batchesApi,
        timeoutMs: 1000,
        pollIntervalMs: 400,
        sleep: () => {
          clock += 400;
          return Promise.resolve();
        },
        now: () => clock,
      });

      const error = await client.pollUntilComplete("b-stuck").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BatchTimeoutError);
      expect((error as InstanceType<typeof BatchTimeoutError>).batchId).toBe("b-stuck");
    });
  });

  describe("retrieveResults", () => {
    it("extracts text + batch-discounted usage from succeeded results", async () => {
      const batchesApi: AnthropicBatchesApi = {
        create: () => Promise.reject(new Error("unused")),
        retrieve: () => Promise.reject(new Error("unused")),
        results: () =>
          Promise.resolve(
            asyncIterableOf([
              {
                custom_id: "q1",
                result: {
                  type: "succeeded",
                  message: {
                    id: "msg_1",
                    type: "message",
                    role: "assistant",
                    model: "claude-sonnet-4-6",
                    content: [{ type: "text", text: "예, 그렇다." }],
                    stop_reason: "end_turn",
                    stop_sequence: null,
                    usage: {
                      input_tokens: 1000,
                      output_tokens: 100,
                      cache_creation_input_tokens: null,
                      cache_read_input_tokens: null,
                      cache_creation: null,
                      server_tool_use: null,
                      service_tier: "batch",
                      inference_geo: null,
                    },
                  },
                },
              },
              // Cast: the fixture only fills the fields the client reads (`content`/`usage`) —
              // the rest of the real `Message` shape (container, usage tiers, ...) is irrelevant
              // here and would just be noise.
            ] as unknown as MessageBatchIndividualResponse[]),
          ),
      };
      const client = createAnthropicBatchClient({ model: model(), batchesApi });

      const results = await client.retrieveResults("b1");

      expect(results).toHaveLength(1);
      const [result] = results;
      expect(result?.customId).toBe("q1");
      expect(result?.text).toBe("예, 그렇다.");
      expect(result?.usage.input).toBe(1000);
      expect(result?.usage.output).toBe(100);
      expect(result?.usage.totalTokens).toBe(1100);
      // model().cost is $3/$15 per million tokens; batch halves it: (1000*3 + 100*15)/1e6 * 0.5.
      expect(result?.usage.cost.input).toBeCloseTo(0.0015);
      expect(result?.usage.cost.output).toBeCloseTo(0.00075);
      expect(result?.usage.cost.total).toBeCloseTo(0.00225);
    });

    it("maps non-succeeded results to empty text + an error tag instead of throwing", async () => {
      const batchesApi: AnthropicBatchesApi = {
        create: () => Promise.reject(new Error("unused")),
        retrieve: () => Promise.reject(new Error("unused")),
        results: () =>
          Promise.resolve(
            asyncIterableOf<MessageBatchIndividualResponse>([
              { custom_id: "expired-1", result: { type: "expired" } },
              { custom_id: "canceled-1", result: { type: "canceled" } },
            ]),
          ),
      };
      const client = createAnthropicBatchClient({ model: model(), batchesApi });

      const results = await client.retrieveResults("b1");

      expect(results).toEqual([
        {
          customId: "expired-1",
          text: "",
          error: "expired",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          fromCache: false,
        },
        {
          customId: "canceled-1",
          text: "",
          error: "canceled",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          fromCache: false,
        },
      ]);
    });
  });

  describe("runBatch", () => {
    it("submits, polls to completion, and retrieves results in order", async () => {
      const calls: string[] = [];
      const batchesApi: AnthropicBatchesApi = {
        create: () => {
          calls.push("create");
          return Promise.resolve(pendingBatch("b-run"));
        },
        retrieve: () => {
          calls.push("retrieve");
          return Promise.resolve(endedBatch("b-run"));
        },
        results: () => {
          calls.push("results");
          return Promise.resolve(asyncIterableOf<MessageBatchIndividualResponse>([]));
        },
      };
      const client = createAnthropicBatchClient({ model: model(), batchesApi });

      const results = await client.runBatch([{ customId: "only", prompt: "질문" }]);

      expect(results).toEqual([]);
      expect(calls).toEqual(["create", "retrieve", "results"]);
    });
  });

  describe("runBatch with cacheStore (#423)", () => {
    it("skips cache hits when submitting, tags results with fromCache, and never persists errored results", async () => {
      const store = new InMemoryStore();
      const keyA = llmCallCacheKey(
        model(),
        { messages: [{ role: "user", content: "질문 A", timestamp: 0 }] },
        { maxTokens: 1024 },
      );
      await store.set(keyA, {
        role: "assistant",
        content: [{ type: "text", text: "캐시된 답" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
        },
        stopReason: "stop",
        timestamp: 0,
      });
      store.setCalls.length = 0; // Reset: the line above seeds the fixture, not part of the SUT.

      let submitted: BatchCreateParams["requests"] | undefined;
      const batchesApi: AnthropicBatchesApi = {
        create: (body) => {
          submitted = body.requests;
          return Promise.resolve(pendingBatch("b-cached"));
        },
        retrieve: () => Promise.resolve(endedBatch("b-cached")),
        results: () =>
          Promise.resolve(
            asyncIterableOf<MessageBatchIndividualResponse>([
              {
                custom_id: "b",
                result: {
                  type: "succeeded",
                  message: {
                    id: "msg_b",
                    type: "message",
                    role: "assistant",
                    model: "claude-sonnet-4-6",
                    content: [{ type: "text", text: "새 답" }],
                    stop_reason: "end_turn",
                    stop_sequence: null,
                    usage: {
                      input_tokens: 10,
                      output_tokens: 5,
                      cache_creation_input_tokens: null,
                      cache_read_input_tokens: null,
                      cache_creation: null,
                      server_tool_use: null,
                      service_tier: "batch",
                      inference_geo: null,
                    },
                  },
                },
              },
              { custom_id: "c", result: { type: "expired" } },
              // Cast: fixture only fills the fields the client reads — see the retrieveResults
              // fixture above for the same rationale.
            ] as unknown as MessageBatchIndividualResponse[]),
          ),
      };
      const client = createAnthropicBatchClient({ model: model(), batchesApi, cacheStore: store });

      const results = await client.runBatch([
        { customId: "a", prompt: "질문 A" },
        { customId: "b", prompt: "질문 B" },
        { customId: "c", prompt: "질문 C" },
      ]);

      // Only the misses (b, c) are submitted — the cache hit (a) never reaches the Batch API.
      expect(submitted?.map((r) => r.custom_id)).toEqual(["b", "c"]);

      const byId = new Map(results.map((r) => [r.customId, r]));
      expect(byId.get("a")).toMatchObject({ fromCache: true, text: "캐시된 답" });
      expect(byId.get("a")?.usage.cost.total).toBe(0);
      expect(byId.get("b")).toMatchObject({ fromCache: false, text: "새 답" });
      expect(byId.get("c")).toMatchObject({ fromCache: false, error: "expired" });

      // The errored result (c) must not be persisted — caching a transient failure would replay
      // it forever (same policy as withLlmCallCache). Only the fresh success (b) is stored.
      expect(store.setCalls).toHaveLength(1);
    });
  });
});

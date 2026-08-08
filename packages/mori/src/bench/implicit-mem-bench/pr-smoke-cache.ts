import { createHash } from "node:crypto";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { LlmCallCacheStore } from "../cache/llm-call-cache.js";

/**
 * PR-smoke-only cache key (#405, #397 조각 1/3). Deliberately NOT `llmCallCacheKey`
 * (cache/llm-call-cache.ts, #372): that key hashes the full `Context` verbatim, and a real
 * `MoriSession.prompt()` turn's messages carry `timestamp: Date.now()`
 * (pi-agent-core's `agent.js`/`agent-loop.js` stamp every user/assistant message) — hashing
 * that raw would make every session-turn call a guaranteed miss on every run, fixture or not.
 * `reader.ts`'s own reader-path calls build their `Context` with `timestamp: 0` fixed, so they
 * were never affected — this key drops `timestamp` recursively so the *session-turn* path
 * (the other caller of this smoke's `streamFn`) becomes just as replayable.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (key === "timestamp") continue;
      out[key] = canonicalize(record[key]);
    }
    return out;
  }
  return value;
}

export function fixtureCacheKey(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): string {
  const keyed = {
    model: { provider: model.provider, id: model.id, api: model.api },
    context,
    params: { temperature: options?.temperature, maxTokens: options?.maxTokens },
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(keyed)))
    .digest("hex");
}

/** Replays a stored `AssistantMessage` as a minimal `start`+`done` stream — same shape
 * `llm-call-cache.ts`'s own (unexported) `replayStream` produces for a cache hit. */
function replayMessage(message: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: "stop", message });
  stream.end(message);
  return stream;
}

/** A fixed, content-free reply — the PR smoke only needs the pipeline to run to completion
 * (real behavioral-adaptation scoring is #388's job, on real models), not a meaningful score.
 * Starts with "예" so it also satisfies the reader/judge calls' "첫 단어를 예/아니오로" contract
 * (`runImplicitMemBenchScenario`'s `createReaderLlmJudge`) without branching on call shape. */
function fixedReply(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "예 — mori bench PR 스모크 고정 응답 (#405)." }],
    api: model.api,
    provider: model.provider,
    model: model.id,
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
}

export interface FixtureCacheStreamFn {
  streamFn: StreamFn;
  missCount(): number;
  hitCount(): number;
}

/**
 * Builds a `StreamFn` that never makes a real provider call: a cache hit replays the stored
 * reply, a cache miss synthesizes `fixedReply` and persists it. Used as `streamFn` for BOTH
 * `runImplicitMemBench`'s session turns (this cache is the only thing making them replayable —
 * see `fixtureCacheKey`'s doc) and, once more, as the seed `streamFn` `createBenchRunner`
 * (runner.ts, #374) wraps again with the standard `withLlmCallCache` for the reader/judge path —
 * that outer wrap's own cache resolves reader calls first (their `Context` is already
 * timestamp-free, cache/reader.ts), so this function's `store.get` only sees them on the outer
 * wrap's own miss. Either way `missCount()` ends up counting every call this run made that
 * wasn't already in `store` — the single signal `pr-smoke.ts` gates CI on.
 */
export function createFixtureCacheStreamFn(store: LlmCallCacheStore): FixtureCacheStreamFn {
  let misses = 0;
  let hits = 0;
  const streamFn: StreamFn = async (model, context, options) => {
    const key = fixtureCacheKey(model, context, options);
    const cached = await store.get(key);
    if (cached) {
      hits += 1;
      return replayMessage(cached);
    }
    misses += 1;
    const message = fixedReply(model);
    await store.set(key, message);
    return replayMessage(message);
  };
  return { streamFn, missCount: () => misses, hitCount: () => hits };
}

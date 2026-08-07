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

/** Storage seam for cached LLM calls. `FileLlmCallCacheStore` (file-cache-store.ts) is the
 * default implementation; bench code can swap in another (e.g. in-memory for its own tests)
 * without touching `withLlmCallCache`. */
export interface LlmCallCacheStore {
  get(key: string): Promise<AssistantMessage | undefined>;
  set(key: string, message: AssistantMessage): Promise<void>;
}

/**
 * Generation parameters folded into the cache key — the "파라미터" third of #372's
 * (모델, 프롬프트, 파라미터) key. Deliberately narrow: only knobs that change what the model
 * is asked to produce. Everything else `SimpleStreamOptions` carries is excluded on purpose —
 * `signal`/`onPayload`/`onResponse` aren't serializable, `apiKey`/`headers` can carry secrets
 * a cache file must never hold, and `transport`/`timeoutMs`/`maxRetries`/`maxRetryDelayMs`/
 * `sessionId`/`cacheRetention`/`metadata`/`env` affect delivery rather than the sampled
 * output — keying on those would either leak a credential into the cache directory or produce
 * a spurious miss for a response that would have replayed byte-identical.
 */
function generationParams(options: SimpleStreamOptions | undefined) {
  return {
    temperature: options?.temperature,
    maxTokens: options?.maxTokens,
    reasoning: options?.reasoning,
    thinkingBudgets: options?.thinkingBudgets,
  };
}

/** The "모델" third of the cache key: identity only, not the full catalog entry (cost,
 * context window, etc. don't change what gets sampled for a given prompt+params). */
function modelIdentity(model: Model<Api>) {
  return { provider: model.provider, id: model.id, api: model.api };
}

/** Deterministic serialization: object keys are sorted so two calls built with the same
 * literal content but different key-insertion order still hash to the same cache key. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The full (모델, 프롬프트, 파라미터) cache key, hashed to a fixed-length id suitable for a
 * filename. "프롬프트" is the full `Context` (system prompt, messages, tools) — anything in
 * it changes what the model sees, so all of it is load-bearing. */
export function llmCallCacheKey(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): string {
  const keyed = {
    model: modelIdentity(model),
    context,
    params: generationParams(options),
  };
  return createHash("sha256").update(stableStringify(keyed)).digest("hex");
}

const CACHEABLE_STOP_REASONS: ReadonlySet<AssistantMessage["stopReason"]> = new Set([
  "stop",
  "length",
  "toolUse",
]);

/** Replays a stored `AssistantMessage` as a minimal two-event stream (`start` then
 * `done`/`error`) — enough for any consumer that awaits `.result()` or iterates events for
 * the terminal message, matching the precedent `agent/fake-provider-models.ts` set for
 * synthesizing streams from a already-resolved message. */
function replayStream(message: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: message });
  if (CACHEABLE_STOP_REASONS.has(message.stopReason)) {
    stream.push({
      type: "done",
      reason: message.stopReason as "stop" | "length" | "toolUse",
      message,
    });
  } else {
    stream.push({
      type: "error",
      reason: message.stopReason as "aborted" | "error",
      error: message,
    });
  }
  stream.end(message);
  return stream;
}

/** Forwards every event from `inner` to a new stream unchanged, and on a cacheable terminal
 * message hands it to `onFinal` *before* forwarding that terminal event — a cache miss looks
 * identical to an uncached call to whoever is consuming the returned stream. This ordering is
 * load-bearing, not cosmetic: `EventStream#push` (pi-ai) resolves `.result()`/ends iteration
 * the instant a `done`/`error` event is pushed, without waiting for `end()` — a consumer that
 * awaits `.result()` and immediately issues the same call again would otherwise race the cache
 * write and can observe a second miss. Error/aborted terminals are not persisted: caching a
 * transient failure would make it replay forever.
 *
 * `onFinal` is expected to swallow its own failures (see `withLlmCallCache`, which wraps
 * `store.set` in a try/catch before passing it in here) — a cache *write* failure must not
 * turn a successful provider response into a synthetic error for the caller. The `.catch`
 * below is reserved for genuine failures of `inner`'s iteration/result, not for `onFinal`.
 *
 * Neither branch calls `outer.end()`: `EventStream#push` (pi-ai
 * `dist/utils/event-stream.js:17-32`, `@earendil-works/pi-ai@0.82.1`) already sets
 * `done = true` and resolves `finalResultPromise` the moment a
 * `done`/`error` event is pushed — `end()` only matters for a stream that finishes without
 * ever pushing a terminal event, which never happens here (both branches always push exactly
 * one `done` or `error` event before returning). Calling it anyway would be a silent no-op
 * for the second-or-later invocation (`resolveFinalResult` only fires once), so leaving it
 * out keeps the two branches symmetric instead of one of them carrying a dead call. */
function tapStream(
  inner: AssistantMessageEventStream,
  model: Model<Api>,
  onFinal: (message: AssistantMessage) => Promise<void>,
): AssistantMessageEventStream {
  const outer = createAssistantMessageEventStream();
  (async () => {
    for await (const event of inner) {
      if (event.type === "done" || event.type === "error") {
        const finalMessage = event.type === "done" ? event.message : event.error;
        if (CACHEABLE_STOP_REASONS.has(finalMessage.stopReason)) {
          await onFinal(finalMessage);
        }
      }
      outer.push(event);
    }
  })().catch((error: unknown) => {
    const identity = modelIdentity(model);
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: identity.api,
      provider: identity.provider,
      model: identity.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    };
    outer.push({ type: "error", reason: "error", error: message });
  });
  return outer;
}

export interface LlmCallCacheHooks {
  onHit?: (key: string) => void;
  onMiss?: (key: string) => void;
  /** Called when persisting a cache-eligible response fails (e.g. a full disk or a read-only
   * cache dir). The response itself still reaches the caller unchanged — a cache *write*
   * failure is equivalent to a cache miss for this call, not a reason to discard a successful,
   * already-paid-for provider response. */
  onStoreError?: (key: string, error: unknown) => void;
}

/**
 * Invokes a hook and swallows anything it throws. `onHit`/`onMiss` run inline in the
 * `StreamFn` this module returns, and `onStoreError` runs inside `tapStream`'s `onFinal`
 * (whose own failures are caught and turned into a synthetic error terminal, see `tapStream`
 * above) — a throwing hook in any of those three spots would otherwise propagate out and turn
 * an already-successful provider response into that same synthetic error (owner review, #374:
 * a bench runner is the first real caller to wire counters/loggers into these hooks, so a bug
 * in a hook must not be able to corrupt the terminal message it's merely observing).
 */
function callHook<Args extends unknown[]>(
  hook: ((...args: Args) => void) | undefined,
  ...args: Args
): void {
  try {
    hook?.(...args);
  } catch {
    // Deliberately swallowed — see doc comment above.
  }
}

/**
 * Wraps a `StreamFn` with deterministic replay: same (model, prompt, params) key → the
 * previously stored response is replayed with zero calls into `streamFn` (#372 completion
 * condition — a fake-provider call counter in a test proves this). A cache miss calls
 * `streamFn` normally and stores its cacheable terminal message for next time.
 */
export function withLlmCallCache(
  streamFn: StreamFn,
  store: LlmCallCacheStore,
  hooks?: LlmCallCacheHooks,
): StreamFn {
  return async (model, context, options) => {
    const key = llmCallCacheKey(model, context, options);
    const cached = await store.get(key);
    if (cached) {
      callHook(hooks?.onHit, key);
      return replayStream(cached);
    }
    callHook(hooks?.onMiss, key);
    const inner = await streamFn(model, context, options);
    return tapStream(inner, model, async (message) => {
      try {
        await store.set(key, message);
      } catch (error) {
        callHook(hooks?.onStoreError, key, error);
      }
    });
  };
}

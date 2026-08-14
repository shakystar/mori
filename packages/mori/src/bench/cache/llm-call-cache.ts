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

/**
 * Strips each message's own `timestamp` field before hashing (#445). Every `Message` variant
 * `Context` carries (`UserMessage`/`AssistantMessage`/`ToolResultMessage`, pi-ai's `types.ts`)
 * has a `timestamp: number` field, and a real `MoriSession.prompt()` turn stamps it with
 * wall-clock `Date.now()` — pi-agent-core's own `agent.js` (user prompt → `Message`) and
 * `agent-loop.js` (assistant/tool-result messages) do this, not mori's code, so nothing in this
 * repo controls it. None of that affects what the model is asked to produce, so a call replayed
 * on a later run must not miss merely because wall-clock time moved between the two runs.
 *
 * This is the actual cause of #401's gate-condition-1 failure (observed in PR #444, cut into
 * this issue as #445): reproduced with a stub provider (`session.ts`'s `createMoriSession` +
 * a scripted `StreamFn`, no real API call) driving the same one-turn prompt through two
 * `MoriSession`s a few milliseconds apart — the two resulting `Context.messages` differ in
 * exactly one field, `messages[0].timestamp` (e.g. `1786736513577` vs `1786736513654`), and
 * that alone was enough to flip `llmCallCacheKey`'s hash.
 *
 * Scoped to each message's own top-level field only, not a recursive sweep of the whole
 * `Context` tree (PR #447 review round 2) — a blanket "strip any key named `timestamp`
 * anywhere" would also silently drop a `timestamp` that happens to live inside a
 * `ToolResultMessage.details` payload (`TDetails = any`) or a future tool's structured result,
 * folding two calls whose tool actually returned different data into the same cache key — the
 * expensive direction of error for a cache (a stale/wrong response replayed for a call that
 * wasn't actually the same). `normalizeVolatilePaths` below is the narrower, caller-declared
 * tool for the other per-run-varying case: a literal scratch path echoed into a tool result's
 * *content*, not into a field named `timestamp`.
 */
function dropMessageTimestamps(context: Context) {
  return {
    ...context,
    messages: context.messages.map((message) => {
      const rest: Record<string, unknown> = { ...message };
      delete rest.timestamp;
      return rest;
    }),
  };
}

/**
 * Replaces each caller-declared absolute path with a fixed, index-keyed placeholder in the
 * serialized key before hashing (#445 완료 조건 1) — a per-run scratch root
 * (`workRoot`/`memorizeRoot`, always a fresh `mkdtemp` directory, see
 * `preference-regression/runner.ts`) can be echoed verbatim into a tool result's *content*,
 * which `dropMessageTimestamps` above can't reach (it only strips a field named `timestamp`,
 * not arbitrary text inside `content`). Two concrete paths this repo's own tools take:
 *
 * - `bash`'s cwd is pinned to the working root (`tools/bash.ts`/`tools/bash-exec.ts`), so a
 *   command as ordinary as `pwd` puts the literal path straight into
 *   `ToolResultMessage.content` — already asserted by `agent/index.test.ts`'s "threads the
 *   injected root to both the path guard and bash's cwd" (unrelated to #445, but it is the
 *   proof this path reaches `Context`).
 * - `bash-exec.ts`'s `sanitizeEnv` strips only mori's own Anthropic credentials from the
 *   child environment; `MEMORIZE_ROOT` (`preference-regression/runner.ts` sets it as a
 *   process-global env var for the run) passes through untouched, so `env`/`printenv` would
 *   surface that root too.
 *
 * Caller-declared only, and matched as an exact substring — this deliberately does not try to
 * detect "things that look like a path" itself. Guessing at that pattern could fold two calls
 * that a real (non-scratch) directory made into the same key, which is the same expensive
 * direction of error `dropMessageTimestamps`'s narrow scope is protecting against above.
 *
 * Constraint on `volatilePaths` entries: matching happens on `serialized`, which is already
 * `stableStringify`'s JSON-escaped text, not the raw pre-serialization string — a caller-declared
 * path containing a character JSON escapes (e.g. a literal backslash) won't `split` cleanly out of
 * that escaped text, so the substitution silently no-ops and the raw path leaks into the key
 * instead of failing loudly. Every current caller (`preference-regression/milestone.ts`,
 * `runner.ts`) passes POSIX `mkdtemp` absolute paths, which never contain such characters, so this
 * hasn't manifested — but it would resurface silently the first time a caller reuses this on
 * paths from a non-POSIX source (e.g. Windows CI). Not handled here: escape-aware matching has no
 * caller to justify it yet.
 *
 * Longest paths are substituted first so a shorter path that is itself a prefix of a longer one
 * (e.g. `workRoot` vs a `workRoot/scenario/condition` subdirectory under it) can't partially
 * consume the longer match and leave a stray fragment of it in the key.
 */
function normalizeVolatilePaths(
  serialized: string,
  volatilePaths: readonly string[] | undefined,
): string {
  if (!volatilePaths || volatilePaths.length === 0) return serialized;
  const byLengthDesc = volatilePaths
    .map((path, index) => ({ path, index }))
    .filter(({ path }) => path.length > 0)
    .sort((a, b) => b.path.length - a.path.length);
  let result = serialized;
  for (const { path, index } of byLengthDesc) {
    result = result.split(path).join(`<VOLATILE_PATH_${index}>`);
  }
  return result;
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

/** `llmCallCacheKey`'s third parameter — `SimpleStreamOptions` (the "파라미터" third of the
 * key) plus `volatilePaths` (#445): a bench-caller-declared list of absolute per-run scratch
 * roots to normalize out of the "프롬프트" third before hashing. See `normalizeVolatilePaths`
 * for why this exists and why it isn't a heuristic. */
export interface LlmCallCacheKeyOptions extends SimpleStreamOptions {
  volatilePaths?: readonly string[];
}

/** The full (모델, 프롬프트, 파라미터) cache key, hashed to a fixed-length id suitable for a
 * filename. "프롬프트" is the full `Context` (system prompt, messages, tools) — everything in
 * it is load-bearing except each message's own `timestamp` (dropped by `dropMessageTimestamps`)
 * and any caller-declared `volatilePaths` substrings (replaced by `normalizeVolatilePaths`) —
 * both carry per-run bookkeeping/scratch-directory noise rather than anything that changes what
 * the model was asked to produce. */
export function llmCallCacheKey(
  model: Model<Api>,
  context: Context,
  options?: LlmCallCacheKeyOptions,
): string {
  const keyed = {
    model: modelIdentity(model),
    context: dropMessageTimestamps(context),
    params: generationParams(options),
  };
  const serialized = normalizeVolatilePaths(stableStringify(keyed), options?.volatilePaths);
  return createHash("sha256").update(serialized).digest("hex");
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
 *
 * `volatilePaths` (#445) is fixed for the lifetime of this wrapper, not per-call — a bench
 * caller wraps once per episode/session with that run's own scratch roots
 * (`preference-regression/runner.ts`'s `RunEpisodeOptions.volatilePaths`), so every call this
 * wrapper makes normalizes the same roots out of the key.
 */
export function withLlmCallCache(
  streamFn: StreamFn,
  store: LlmCallCacheStore,
  hooks?: LlmCallCacheHooks,
  volatilePaths?: readonly string[],
): StreamFn {
  return async (model, context, options) => {
    const key = llmCallCacheKey(
      model,
      context,
      volatilePaths === undefined ? options : { ...options, volatilePaths },
    );
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

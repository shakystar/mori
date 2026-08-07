import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type CredentialStore,
  type MutableModels,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createMoriModels } from "./model-wiring.js";

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Adapts a `StreamFn` test double (which, like a hanging-then-rejecting stub, may return a
 * `Promise`) into the stricter contract `Provider#stream`/`#streamSimple` declare: a
 * synchronously-returned `AssistantMessageEventStream`. pi-ai's own `lazyStream` does the
 * same synchronous-handoff job for real providers, but it hardcodes a setup failure to
 * `stopReason: "error"` (`api/lazy.ts`) — it exists for auth-resolution/module-load
 * failures, not per-request cancellation. Routing a `StreamFn` that rejects when the
 * turn's own `AbortSignal` fires through that would turn a Ctrl-C mid-turn into a
 * misleading "mori: aborted" error message instead of `cli/repl.ts`'s normal cancellation
 * notice (its `stopReason === "aborted"` branch) — the same distinction
 * `Agent#handleRunFailure` (pi-agent-core) makes by checking `abortController.signal.aborted`
 * when a raw `StreamFn` throws directly. This adapter reads that same signal to keep the
 * distinction alive once the seam a test double is bound to changes.
 */
function adaptStreamFn(streamFn: StreamFn) {
  return (
    model: Parameters<StreamFn>[0],
    context: Parameters<StreamFn>[1],
    options?: Parameters<StreamFn>[2],
  ) => {
    const stream = createAssistantMessageEventStream();
    (async () => {
      const inner = await streamFn(model, context, options);
      for await (const event of inner) {
        stream.push(event);
      }
      // A double that ends via `end(message)` rather than pushing a terminal `done`/`error`
      // event (pi-ai's own `forwardStream`, api/lazy.js, has the same requirement) leaves
      // `stream` at `done: false` forever if this isn't forwarded — `.result()`/`for await`
      // on the outer stream then hangs instead of failing loudly.
      stream.end(await inner.result());
    })().catch((error: unknown) => {
      const aborted = options?.signal?.aborted ?? false;
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: EMPTY_USAGE,
        stopReason: aborted ? "aborted" : "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      };
      stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
    });
    return stream;
  };
}

/**
 * Test helper (#336): a `Models` wired exactly like production (`createMoriModels`) — same
 * registered providers, same auth/model-catalog resolution — except `providerId`'s provider
 * has its `stream`/`streamSimple` replaced by `streamFn` (via `adaptStreamFn` above).
 * Registering a whole fake provider, rather than threading a bare `StreamFn` past `Models`
 * the way the old `deps.streamFn` / `createMoriAgent(..., streamFn)` seams did, is what lets
 * one instance serve every surface that resolves through `Models`: the CLI auth gate
 * (`cli/runtime.ts`), the real turn (`agent/index.ts`'s `createMoriAgent`), and a bare
 * `pi-agent-core` `Agent` driven directly off `models.streamSimple.bind(models)`.
 *
 * Auth is NOT faked: `providerId` still resolves through the real `credentialStore`/`env`,
 * so a caller must configure it exactly as a real request would (e.g. `ANTHROPIC_API_KEY` in
 * `env`) or `Models#streamSimple` rejects with "Provider is not configured" before
 * `streamFn` is ever reached.
 */
export function fakeProviderModels(
  env: NodeJS.ProcessEnv,
  credentialStore: CredentialStore,
  streamFn: StreamFn,
  providerId = "anthropic",
): MutableModels {
  const models = createMoriModels(env, credentialStore);
  const provider = models.getProvider(providerId);
  if (!provider) {
    throw new Error(`fakeProviderModels: unknown provider "${providerId}"`);
  }
  const adapted = adaptStreamFn(streamFn);
  models.setProvider({ ...provider, stream: adapted, streamSimple: adapted });
  return models;
}

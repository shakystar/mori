/**
 * `MEMORIZE_EMBEDDINGS_*` env resolution — the ONE place in the tree that reads
 * embeddings configuration (#82). It lives in the harness, not the kernel, for
 * the same reason `ConsolidatorLlm` does: the kernel takes an injected
 * `Embedder` and knows nothing about how it was configured.
 */

import { SESSION_START_EMBED_TIMEOUT_MS } from "@mori/kernel";

export interface EmbeddingsConfig {
  /** Base URL of an OpenAI-compatible API exposing `/embeddings`. */
  endpoint: string;
  /** Optional — a local server (Ollama) may need none; cloud needs a key. */
  apiKey?: string;
  model: string;
  /** HTTP timeout override; tight at latency-sensitive boundaries. */
  timeoutMs?: number;
  /** Test seam; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * The same endpoint/model/key with the SESSION START budget baked in — the
 * "APPLIED by the harness" half of the kernel's `SESSION_START_EMBED_TIMEOUT_MS`
 * (context-service.ts declares the policy; the kernel builds no clients).
 *
 * A SEPARATE config, not a mutation of the shared one: consolidation embeds
 * whole windows through the same endpoint and needs the full
 * `EMBEDDINGS_TIMEOUT_MS`, so tightening one client to 5s must not tighten that
 * one. Undefined in, undefined out — embeddings unconfigured stays FTS-only.
 */
export function sessionStartEmbeddingsConfig(
  config: EmbeddingsConfig | undefined,
): EmbeddingsConfig | undefined {
  return config ? { ...config, timeoutMs: SESSION_START_EMBED_TIMEOUT_MS } : undefined;
}

export const DEFAULT_EMBEDDINGS_ENDPOINT = "https://api.openai.com/v1";
export const DEFAULT_EMBEDDINGS_MODEL = "text-embedding-3-small";
export const EMBEDDINGS_TIMEOUT_MS = 20_000;

/**
 * Resolve embeddings config from env. Enabled when EITHER an endpoint OR a key
 * is set — this is a deliberate widening of the consolidator's key-only gate so
 * a keyless local server (Ollama) can be opted into with just the endpoint. Both
 * absent → undefined → semantic features off, FTS5 lexical search unchanged.
 */
export function resolveEmbeddingsConfig(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingsConfig | undefined {
  const endpoint = env.MEMORIZE_EMBEDDINGS_ENDPOINT;
  const apiKey = env.MEMORIZE_EMBEDDINGS_API_KEY;
  if (!endpoint && !apiKey) return undefined;
  return {
    // `||`, not `??`: an explicitly-set-but-empty env var (`FOO=`, a YAML null
    // in docker-compose, an unset CI secret) must fall back to the default the
    // same way an absent var does — see mori#121.
    endpoint: endpoint || DEFAULT_EMBEDDINGS_ENDPOINT,
    ...(apiKey ? { apiKey } : {}),
    model: env.MEMORIZE_EMBEDDINGS_MODEL || DEFAULT_EMBEDDINGS_MODEL,
  };
}

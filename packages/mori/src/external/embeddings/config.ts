/**
 * `MEMORIZE_EMBEDDINGS_*` env resolution — the ONE place in the tree that reads
 * embeddings configuration (#82). It lives in the harness, not the kernel, for
 * the same reason `ConsolidatorLlm` does: the kernel takes an injected
 * `Embedder` and knows nothing about how it was configured.
 */

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
    endpoint: endpoint ?? DEFAULT_EMBEDDINGS_ENDPOINT,
    ...(apiKey ? { apiKey } : {}),
    model: env.MEMORIZE_EMBEDDINGS_MODEL ?? DEFAULT_EMBEDDINGS_MODEL,
  };
}

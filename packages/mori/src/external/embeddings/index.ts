import type { Embedder } from "@mori/kernel";

import { resolveEmbeddingsConfig, type EmbeddingsConfig } from "./config.js";
import { HttpEmbedder } from "./http-embedder.js";

export {
  DEFAULT_EMBEDDINGS_ENDPOINT,
  DEFAULT_EMBEDDINGS_MODEL,
  EMBEDDINGS_TIMEOUT_MS,
  resolveEmbeddingsConfig,
  type EmbeddingsConfig,
} from "./config.js";
export { HttpEmbedder, MAX_EMBED_BATCH_CHARS, MIN_EMBED_INPUT_CHARS } from "./http-embedder.js";

/**
 * Build the kernel's `Embedder` from config (or env). Undefined when
 * unconfigured — the caller then passes `undefined` into the kernel, which
 * degrades to FTS5 lexical search.
 *
 * This is the harness's single construction point for the seam. The kernel never
 * calls it; a host that wants a different embedding provider substitutes its own
 * `Embedder` here without touching kernel code.
 *
 * `config` is a rest tuple, not a defaulted parameter: a plain `config:
 * EmbeddingsConfig | undefined = resolveEmbeddingsConfig()` can't tell "the
 * caller omitted this, resolve from ambient env" apart from "the caller
 * already resolved a config and got `undefined` (explicitly disabled)" —
 * both look like `undefined` to a default parameter, so the second case
 * would silently re-read `process.env` instead of staying off (PR #90
 * review; same fix as `getConsolidatorLlm`, ../consolidator/index.ts).
 */
export function getEmbedder(
  ...configArg: [config: EmbeddingsConfig | undefined] | []
): Embedder | undefined {
  const config = configArg.length > 0 ? configArg[0] : resolveEmbeddingsConfig();
  return config ? new HttpEmbedder(config) : undefined;
}

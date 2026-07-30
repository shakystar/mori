import type { Models } from "@earendil-works/pi-ai";
import type { ConsolidatorLlm } from "@mori/kernel";

import { resolveConsolidatorConfig, type ConsolidatorConfig } from "./config.js";
import { PiConsolidatorLlm } from "./pi-consolidator.js";

export {
  DEFAULT_CONSOLIDATE_PROVIDER_ID,
  resolveConsolidatorConfig,
  type ConsolidatorConfig,
} from "./config.js";
export { PiConsolidatorLlm } from "./pi-consolidator.js";

/**
 * Build the kernel's `ConsolidatorLlm` from config (or env). Undefined when
 * unconfigured — the caller then passes `undefined` where the kernel expects
 * a `ConsolidatorLlm`, and consolidation stays off (`getEmbedder()`'s
 * contract, ../embeddings/index.ts).
 *
 * This is the harness's single construction point for the seam. `models` is
 * the already-wired `Models`/`MutableModels` from `createMoriModels`
 * (`../../model-wiring.ts`) — this function does not read credentials or
 * register providers itself.
 *
 * `config` is a rest tuple, not a defaulted parameter: a plain `config:
 * ConsolidatorConfig | undefined = resolveConsolidatorConfig()` can't tell
 * "the caller omitted this, resolve from ambient env" apart from "the caller
 * already resolved a config and got `undefined` (explicitly disabled)" —
 * both look like `undefined` to a default parameter, so the second case
 * would silently re-read `process.env` instead of staying off.
 */
export function getConsolidatorLlm(
  models: Models,
  ...configArg: [config: ConsolidatorConfig | undefined] | []
): ConsolidatorLlm | undefined {
  const config = configArg.length > 0 ? configArg[0] : resolveConsolidatorConfig();
  return config ? new PiConsolidatorLlm(models, config.providerId, config.modelId) : undefined;
}

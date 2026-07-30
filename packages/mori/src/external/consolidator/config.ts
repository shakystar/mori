/**
 * `MORI_CONSOLIDATE_*` env resolution — the ONE place in the tree that reads
 * consolidator configuration (#106). It lives in the harness, not the kernel,
 * for the same reason `resolveEmbeddingsConfig` does (../embeddings/config.ts):
 * the kernel takes an injected `ConsolidatorLlm` and knows nothing about how
 * it was configured.
 */

export interface ConsolidatorConfig {
  providerId: string;
  modelId: string;
}

/**
 * Provider used when `MORI_CONSOLIDATE_MODEL` is a bare model id (no "/") —
 * mirrors `DEFAULT_PROVIDER_ID` in `../../provider-selection.ts`, whose
 * `MORI_MODEL` parsing this deliberately copies (same env-var shape, same
 * "bare value has no provider" rule) so a second config surface doesn't ask
 * users to learn a second convention.
 */
export const DEFAULT_CONSOLIDATE_PROVIDER_ID = "anthropic";

/**
 * Resolve consolidator LLM selection from env. Restores the consolidator's
 * original key-only gate (see `../embeddings/config.ts`'s "deliberate
 * widening" comment): `MORI_CONSOLIDATE_MODEL` absent → `undefined`,
 * consolidation off. Set → `"<providerId>/<modelId>"`, or a bare model id
 * that resolves against `DEFAULT_CONSOLIDATE_PROVIDER_ID` (`MORI_MODEL`'s
 * convention, see `../../provider-selection.ts`).
 */
export function resolveConsolidatorConfig(
  env: NodeJS.ProcessEnv = process.env,
): ConsolidatorConfig | undefined {
  const raw = env.MORI_CONSOLIDATE_MODEL;
  if (!raw) return undefined;

  const slash = raw.indexOf("/");
  if (slash === -1) {
    return { providerId: DEFAULT_CONSOLIDATE_PROVIDER_ID, modelId: raw };
  }
  return { providerId: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
}

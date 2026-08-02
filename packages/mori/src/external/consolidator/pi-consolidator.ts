import { contentText, type Models } from "@earendil-works/pi-ai";
import { RESERVED_OUTPUT_TOKENS, type ConsolidatorLlm } from "@mori/kernel";

/**
 * The harness implementation of the kernel's `ConsolidatorLlm` seam
 * (`@mori/kernel`'s `ConsolidatorLlm`): a single pi-ai completion call. The
 * prompt is passed through verbatim as one user message — the kernel's
 * `consolidate-service` owns prompt construction, this seam only executes it.
 *
 * `models` is injected rather than built here: credential/provider resolution
 * stays in `model-wiring.ts` (`createMoriModels`/`moriProviders`), and tests
 * substitute a `Models` wired with pi-ai's Faux Provider.
 */
export class PiConsolidatorLlm implements ConsolidatorLlm {
  constructor(
    private readonly models: Models,
    private readonly providerId: string,
    private readonly modelId: string,
  ) {}

  /**
   * #143 item② — the extraction prompt's char budget (`extractionCharBudget`
   * in `@mori/kernel`'s consolidate-service) is sized off this. pi-ai's
   * `Model.contextWindow` is the model's declared total context window in
   * tokens (verified against `packages/mori/node_modules/@earendil-works/pi-ai/dist/types.d.ts`,
   * `Model<TApi>.contextWindow: number` — every registered model has one, it
   * is not optional there). A getter, not a field cached at construction: the
   * only way to resolve a model here is `models.getModel`, which `complete()`
   * already re-calls on every invocation for its own "unknown model" error
   * path, so this stays consistent with that instead of caching a snapshot
   * that could disagree with it. Undefined only when the configured
   * provider/model is not registered at all, matching `complete()`'s own
   * unknown-model condition — the kernel then falls back to its fixed
   * conservative budget, same as it does for a `ConsolidatorLlm` that never
   * declares this field.
   */
  get contextWindowTokens(): number | undefined {
    return this.models.getModel(this.providerId, this.modelId)?.contextWindow;
  }

  /**
   * Throws on failure. Unlike `Embedder` (never throws — search falls back to
   * FTS5), consolidation has no such fallback: the kernel's
   * `consolidate-service` needs "LLM failed" distinguishable from "nothing to
   * distill" at its own boundary, not collapsed into a silent empty string.
   *
   * Any `stopReason` other than `"stop"` throws, not just `"error"`/`"aborted"`:
   * a `"length"` truncation can still end on syntactically valid partial JSON,
   * which the kernel's memory parser would then silently accept as complete,
   * permanently advancing the consolidation watermark past dropped memories.
   *
   * The request itself is capped at `RESERVED_OUTPUT_TOKENS` (#169) — the same
   * output budget `@mori/kernel`'s `extractionCharBudget` already reserves out
   * of the model's declared context window when sizing the INPUT side. Without
   * this, nothing generation-time stops the model from running past that
   * reservation; the only enforcement left would be `parseExtractedMemories`'s
   * post-hoc slice, which only ever sees a reply that already finished (or hit
   * `"length"` and been thrown above).
   */
  async complete(prompt: string): Promise<string> {
    const model = this.models.getModel(this.providerId, this.modelId);
    if (!model) {
      throw new Error(
        `mori: 알 수 없는 consolidator 모델 "${this.modelId}" (프로바이더 "${this.providerId}").`,
      );
    }

    const result = await this.models.completeSimple(
      model,
      { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
      { maxTokens: RESERVED_OUTPUT_TOKENS },
    );
    if (result.stopReason !== "stop") {
      throw new Error(result.errorMessage ?? `consolidator LLM stream ended: ${result.stopReason}`);
    }
    return contentText(result.content);
  }
}

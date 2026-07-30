import { contentText, type Models } from "@earendil-works/pi-ai";
import type { ConsolidatorLlm } from "@mori/kernel";

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
   * Throws on failure. Unlike `Embedder` (never throws — search falls back to
   * FTS5), consolidation has no such fallback: the kernel's
   * `consolidate-service` needs "LLM failed" distinguishable from "nothing to
   * distill" at its own boundary, not collapsed into a silent empty string.
   *
   * Any `stopReason` other than `"stop"` throws, not just `"error"`/`"aborted"`:
   * a `"length"` truncation can still end on syntactically valid partial JSON,
   * which the kernel's memory parser would then silently accept as complete,
   * permanently advancing the consolidation watermark past dropped memories.
   */
  async complete(prompt: string): Promise<string> {
    const model = this.models.getModel(this.providerId, this.modelId);
    if (!model) {
      throw new Error(
        `mori: 알 수 없는 consolidator 모델 "${this.modelId}" (프로바이더 "${this.providerId}").`,
      );
    }

    const result = await this.models.completeSimple(model, {
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    });
    if (result.stopReason !== "stop") {
      throw new Error(result.errorMessage ?? `consolidator LLM stream ended: ${result.stopReason}`);
    }
    return contentText(result.content);
  }
}

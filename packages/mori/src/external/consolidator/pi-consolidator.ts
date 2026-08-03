import { contentText, type Models } from "@earendil-works/pi-ai";
import {
  reservedOutputTokensFor,
  type ConsolidatorLlm,
  type ConsolidatorLlmCallOptions,
} from "@mori/kernel";

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
   * The request itself is capped at `reservedOutputTokensFor(contextWindowTokens)`
   * (#169) — the same output budget `@mori/kernel`'s `extractionCharBudget`
   * already reserves out of the model's declared context window when sizing
   * the INPUT side, clamped to this model's own window (PR #197 review,
   * 2026-08-03) so a narrow-window model is never asked for a completion
   * bigger than the window it declared. That clamp alone still misses a wide
   * window paired with a low per-request output ceiling (128k context, 4k/8k
   * max completion — a common real-world shape, not a narrow-context edge
   * case): `reservedOutputTokensFor` never sees that ceiling, so it would ask
   * for more than the provider allows and the provider rejects the request
   * before generation starts (Codex P1, PR #197 review, 2026-08-03). It is
   * further clamped to `model.maxTokens` — pi-ai's declared per-request
   * output ceiling for this model (verified in
   * `packages/mori/node_modules/@earendil-works/pi-ai/dist/types.d.ts`,
   * `Model<TApi>.maxTokens: number` — required, not optional, on every
   * registered model, so no undefined case to fall back from). The kernel
   * owns "how much did we reserve"; the adapter owns "how much may this
   * model actually be asked for" — `reservedOutputTokensFor`'s signature
   * stays context-window-only, this ceiling is read here instead. Without
   * either cap, nothing generation-time stops the model from running past
   * the reservation; the only enforcement left would be
   * `parseExtractedMemories`'s post-hoc slice, which only ever sees a reply
   * that already finished (or hit `"length"` and been thrown above).
   *
   * `opts.signal` (#167) is forwarded into `completeSimple`'s own `signal` —
   * pi-ai's `StreamOptions.signal` — so a cancellation arriving while THIS
   * request is in flight actually stops it, not just one that arrived before
   * `complete` was called. pi-ai never rejects on abort; the stream instead
   * resolves with `stopReason: "aborted"` (`streamWithDeltas`, `faux.js`), so
   * that case is thrown here explicitly, with `name` set to the
   * `AbortController`/`fetch` convention (`"AbortError"`) — the same
   * convention `ConsolidateAbortedError` uses for the preflight case — so
   * `classifyConsolidateError`/`consolidateExplicit` recognize it identically
   * regardless of which of the two points caught the cancellation.
   */
  async complete(prompt: string, opts?: ConsolidatorLlmCallOptions): Promise<string> {
    const model = this.models.getModel(this.providerId, this.modelId);
    if (!model) {
      throw new Error(
        `mori: 알 수 없는 consolidator 모델 "${this.modelId}" (프로바이더 "${this.providerId}").`,
      );
    }

    const result = await this.models.completeSimple(
      model,
      { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
      {
        maxTokens: Math.min(reservedOutputTokensFor(this.contextWindowTokens), model.maxTokens),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      },
    );
    if (result.stopReason !== "stop") {
      if (result.stopReason === "aborted") {
        const error = new Error(result.errorMessage ?? "consolidator LLM request aborted");
        error.name = "AbortError";
        throw error;
      }
      throw new Error(result.errorMessage ?? `consolidator LLM stream ended: ${result.stopReason}`);
    }
    return contentText(result.content);
  }
}

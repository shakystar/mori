import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { RESERVED_OUTPUT_TOKENS, reservedOutputTokensFor } from "@mori/kernel";
import { describe, expect, it } from "vitest";

import { PiConsolidatorLlm } from "./pi-consolidator.js";

describe("PiConsolidatorLlm", () => {
  it("passes the prompt through verbatim and returns the model's text unchanged", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);

    let seenPrompt: unknown;
    faux.setResponses([
      (context) => {
        seenPrompt = context.messages[0]?.content;
        return fauxAssistantMessage("distilled summary");
      },
    ]);

    const llm = new PiConsolidatorLlm(models, faux.provider.id, faux.getModel().id);
    const result = await llm.complete("raw consolidation prompt");

    expect(seenPrompt).toBe("raw consolidation prompt");
    expect(result).toBe("distilled summary");
  });

  it("throws when the model stream ends in an error", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "rate limited" }),
    ]);

    const llm = new PiConsolidatorLlm(models, faux.provider.id, faux.getModel().id);

    await expect(llm.complete("prompt")).rejects.toThrow("rate limited");
  });

  it("throws on token-limit truncation instead of returning a partial result", async () => {
    // A "length" stop can still end on syntactically valid partial JSON, which
    // the kernel's memory parser would otherwise accept as a complete
    // consolidation and advance the watermark past the dropped remainder.
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('[{"truncated": tr', { stopReason: "length" })]);

    const llm = new PiConsolidatorLlm(models, faux.provider.id, faux.getModel().id);

    await expect(llm.complete("prompt")).rejects.toThrow(/length/);
  });

  it("caps completeSimple's maxTokens at the kernel's RESERVED_OUTPUT_TOKENS (#169)", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);

    let seenMaxTokens: number | undefined;
    faux.setResponses([
      (_context, options) => {
        seenMaxTokens = options?.maxTokens;
        return fauxAssistantMessage("distilled summary");
      },
    ]);

    const llm = new PiConsolidatorLlm(models, faux.provider.id, faux.getModel().id);
    await llm.complete("prompt");

    expect(seenMaxTokens).toBe(RESERVED_OUTPUT_TOKENS);
  });

  // PR #197 review (2026-08-03, owner decision): requesting the unclamped
  // RESERVED_OUTPUT_TOKENS unconditionally is itself a regression this PR
  // introduced — a model whose declared contextWindow is below that ceiling
  // would be asked for a physically impossible completion (Codex P1,
  // pi-consolidator.ts:86). The adapter must clamp to the resolved model's
  // own window via the same `reservedOutputTokensFor` the kernel's input
  // budget already uses, not the raw constant.
  it("clamps completeSimple's maxTokens to the resolved model's own narrow context window (#169 x #174)", async () => {
    const faux = fauxProvider({ models: [{ id: "narrow-model", contextWindow: 4_000 }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let seenMaxTokens: number | undefined;
    faux.setResponses([
      (_context, options) => {
        seenMaxTokens = options?.maxTokens;
        return fauxAssistantMessage("distilled summary");
      },
    ]);

    const llm = new PiConsolidatorLlm(models, faux.provider.id, "narrow-model");
    await llm.complete("prompt");

    expect(seenMaxTokens).toBe(reservedOutputTokensFor(4_000));
    expect(seenMaxTokens).toBeLessThan(RESERVED_OUTPUT_TOKENS);
    expect(seenMaxTokens).toBeLessThan(4_000);
  });

  it("forwards opts.signal into the request and throws an AbortError when it aborts mid-flight (#167)", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);

    let sawSignal: AbortSignal | undefined;
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    faux.setResponses([
      (_context, options) => {
        sawSignal = options?.signal;
        requestStarted();
        // Hangs until the forwarded signal fires — mirrors how the real transport
        // (fetch, an SDK's own cancel) would behave, and how pi-ai's own faux/real
        // streams resolve on abort: with an AssistantMessage, not a rejection.
        return new Promise((resolve) => {
          options?.signal?.addEventListener("abort", () => {
            resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
          });
        });
      },
    ]);

    const llm = new PiConsolidatorLlm(models, faux.provider.id, faux.getModel().id);
    const controller = new AbortController();
    const completion = llm.complete("prompt", { signal: controller.signal });
    // Wait until the request has ACTUALLY reached the provider (so the signal was not yet
    // aborted when it got there) before aborting — otherwise the abort could fire before the
    // listener above is attached, which would never resolve the faux response's promise.
    await started;
    controller.abort();

    await expect(completion).rejects.toMatchObject({ name: "AbortError" });
    expect(sawSignal).toBe(controller.signal);
  });

  it("consolidates normally when no opts are passed (regression, #167)", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("distilled summary")]);

    const llm = new PiConsolidatorLlm(models, faux.provider.id, faux.getModel().id);

    await expect(llm.complete("prompt")).resolves.toBe("distilled summary");
  });

  it("throws when the configured provider/model is not registered", async () => {
    const models = createModels();

    const llm = new PiConsolidatorLlm(models, "nope", "nope");

    await expect(llm.complete("prompt")).rejects.toThrow(/알 수 없는 consolidator 모델/);
  });

  it("declares contextWindowTokens from the resolved model's contextWindow (#143 item②)", () => {
    const faux = fauxProvider({ models: [{ id: "small-model", contextWindow: 32_000 }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const llm = new PiConsolidatorLlm(models, faux.provider.id, "small-model");

    expect(llm.contextWindowTokens).toBe(32_000);
  });

  it("leaves contextWindowTokens undefined when the provider/model is not registered", () => {
    const models = createModels();

    const llm = new PiConsolidatorLlm(models, "nope", "nope");

    expect(llm.contextWindowTokens).toBeUndefined();
  });
});

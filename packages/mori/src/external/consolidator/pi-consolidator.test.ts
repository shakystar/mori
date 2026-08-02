import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { RESERVED_OUTPUT_TOKENS } from "@mori/kernel";
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

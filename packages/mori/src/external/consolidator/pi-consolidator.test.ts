import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
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

  it("throws when the configured provider/model is not registered", async () => {
    const models = createModels();

    const llm = new PiConsolidatorLlm(models, "nope", "nope");

    await expect(llm.complete("prompt")).rejects.toThrow(/알 수 없는 consolidator 모델/);
  });
});

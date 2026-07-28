import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  resolveProviderSelection,
  SUPPORTED_PROVIDER_IDS,
  unknownProviderMessage,
} from "./provider-selection.js";

describe("resolveProviderSelection", () => {
  it("defaults to anthropic's default model when MORI_MODEL is unset", () => {
    expect(resolveProviderSelection({})).toEqual({
      providerId: DEFAULT_PROVIDER_ID,
      modelId: DEFAULT_MODEL_ID,
    });
  });

  it("reads a bare MORI_MODEL (no '/') as an anthropic model id", () => {
    expect(resolveProviderSelection({ MORI_MODEL: "claude-sonnet-4-6" })).toEqual({
      providerId: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
  });

  it("parses '<provider>/<model>' into its two parts", () => {
    expect(resolveProviderSelection({ MORI_MODEL: "openai/gpt-5.4" })).toEqual({
      providerId: "openai",
      modelId: "gpt-5.4",
    });
  });

  it("splits at the first '/' only, leaving the rest in the model id", () => {
    expect(resolveProviderSelection({ MORI_MODEL: "openai/gpt-5/extra" })).toEqual({
      providerId: "openai",
      modelId: "gpt-5/extra",
    });
  });
});

describe("unknownProviderMessage", () => {
  it("names the offending provider and lists supported ones", () => {
    const message = unknownProviderMessage("bogus");
    expect(message).toContain("bogus");
    for (const id of SUPPORTED_PROVIDER_IDS) {
      expect(message).toContain(id);
    }
  });
});

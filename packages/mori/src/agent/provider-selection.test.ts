import { describe, expect, it } from "vitest";
import { EXPERIMENTAL_OPENAI_OAUTH_ENV, OPENAI_OAUTH_PROVIDER_ID } from "../auth/experimental.js";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  resolveProviderSelection,
  supportedProviderIds,
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

describe("supportedProviderIds", () => {
  it("offers only the API-key providers when the experimental gate is unset", () => {
    // #44 hard constraint 1: with no configuration at all, the experimental
    // subscription-OAuth provider must not exist as far as the user can tell.
    expect(supportedProviderIds({})).toEqual(["anthropic", "openai", "deepseek"]);
  });

  it("adds the experimental OpenAI OAuth provider once the gate is set to 1", () => {
    expect(supportedProviderIds({ [EXPERIMENTAL_OPENAI_OAUTH_ENV]: "1" })).toEqual([
      "anthropic",
      "openai",
      "deepseek",
      OPENAI_OAUTH_PROVIDER_ID,
    ]);
  });

  it("includes deepseek in the selectable ids", () => {
    expect(supportedProviderIds({})).toContain("deepseek");
  });
});

describe("unknownProviderMessage", () => {
  it("names the offending provider and lists supported ones", () => {
    const message = unknownProviderMessage("bogus", {});
    expect(message).toContain("bogus");
    for (const id of supportedProviderIds({})) {
      expect(message).toContain(id);
    }
  });

  it("keeps the gated-off experimental provider out of the supported list it prints", () => {
    expect(unknownProviderMessage(OPENAI_OAUTH_PROVIDER_ID, {})).toContain(
      "지원하는 프로바이더: anthropic, openai, deepseek\n",
    );
  });
});

import { describe, expect, it } from "vitest";
import { EXPERIMENTAL_OPENAI_OAUTH_ENV, experimentalOpenAiOAuthEnabled } from "./experimental.js";

describe("experimentalOpenAiOAuthEnabled", () => {
  it("is on when the gate is set to exactly 1", () => {
    expect(experimentalOpenAiOAuthEnabled({ [EXPERIMENTAL_OPENAI_OAUTH_ENV]: "1" })).toBe(true);
    expect(experimentalOpenAiOAuthEnabled({ [EXPERIMENTAL_OPENAI_OAUTH_ENV]: " 1 " })).toBe(true);
  });

  it("is off for anything else, including truthy-looking values", () => {
    // Failing closed is the whole point: the cost of this gate opening by accident is an
    // account suspension, not a missing feature (#35 §6). Only the value the human decision
    // named turns it on.
    const off = [undefined, "", "  ", "0", "true", "TRUE", "yes", "on", "2"];
    for (const value of off) {
      expect(experimentalOpenAiOAuthEnabled({ [EXPERIMENTAL_OPENAI_OAUTH_ENV]: value })).toBe(
        false,
      );
    }
    expect(experimentalOpenAiOAuthEnabled({})).toBe(false);
  });
});

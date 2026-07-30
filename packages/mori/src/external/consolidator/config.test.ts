import { createModels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { DEFAULT_CONSOLIDATE_PROVIDER_ID, resolveConsolidatorConfig } from "./config.js";
import { getConsolidatorLlm } from "./index.js";

// Every case passes an explicit env object, so nothing here depends on the
// ambient process.env (see ../embeddings/config.test.ts).
describe("resolveConsolidatorConfig", () => {
  it("off when MORI_CONSOLIDATE_MODEL is unset — the consolidator's key-only gate", () => {
    expect(resolveConsolidatorConfig({})).toBeUndefined();
  });

  it("a bare model id resolves against DEFAULT_CONSOLIDATE_PROVIDER_ID", () => {
    expect(resolveConsolidatorConfig({ MORI_CONSOLIDATE_MODEL: "claude-haiku-4-5" })).toEqual({
      providerId: DEFAULT_CONSOLIDATE_PROVIDER_ID,
      modelId: "claude-haiku-4-5",
    });
  });

  it("`<providerId>/<modelId>` selects both explicitly", () => {
    expect(resolveConsolidatorConfig({ MORI_CONSOLIDATE_MODEL: "openai/gpt-5.1-mini" })).toEqual({
      providerId: "openai",
      modelId: "gpt-5.1-mini",
    });
  });
});

describe("getConsolidatorLlm", () => {
  it("returns undefined when unconfigured, so the kernel gets an explicit off", () => {
    // Resolve against an EMPTY env, not `undefined` — passing undefined would
    // fire getConsolidatorLlm's `= resolveConsolidatorConfig()` default and
    // read the ambient process.env (see ../embeddings/config.test.ts, PR #90
    // review — same failure mode applies here).
    // A real Models instance is never touched when config is undefined.
    expect(getConsolidatorLlm(createModels(), resolveConsolidatorConfig({}))).toBeUndefined();
  });
});

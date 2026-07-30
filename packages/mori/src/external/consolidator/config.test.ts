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
  it("returns undefined when explicitly resolved off, without falling back to ambient env", () => {
    // resolveConsolidatorConfig({}) itself evaluates to `undefined` — passing
    // that through is indistinguishable from omitting the argument to a
    // defaulted parameter, which is exactly why getConsolidatorLlm takes
    // `config` as a rest tuple instead: `configArg.length > 0` here is 1, so
    // the explicit `undefined` is honored rather than re-reading
    // process.env (see index.ts's doc comment; PR #90 review raised the
    // same failure mode for ../embeddings).
    // A real Models instance is never touched when config is undefined.
    expect(getConsolidatorLlm(createModels(), resolveConsolidatorConfig({}))).toBeUndefined();
  });
});

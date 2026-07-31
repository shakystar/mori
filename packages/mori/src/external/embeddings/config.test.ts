import { describe, expect, it } from "vitest";

import { getEmbedder } from "./index.js";
import {
  DEFAULT_EMBEDDINGS_ENDPOINT,
  DEFAULT_EMBEDDINGS_MODEL,
  resolveEmbeddingsConfig,
} from "./config.js";

// Moved from packages/kernel/tests/integration/semantic-search.test.ts in #82:
// MEMORIZE_EMBEDDINGS_* resolution is a harness concern now. Every case passes
// an explicit env object, so nothing here depends on the ambient process.env.
describe("resolveEmbeddingsConfig", () => {
  it("enabled by endpoint OR key, else off", () => {
    expect(resolveEmbeddingsConfig({})).toBeUndefined();
    expect(resolveEmbeddingsConfig({ MEMORIZE_EMBEDDINGS_API_KEY: "k" })).toMatchObject({
      apiKey: "k",
    });
    // Keyless local server: endpoint alone enables it (no apiKey field).
    const local = resolveEmbeddingsConfig({
      MEMORIZE_EMBEDDINGS_ENDPOINT: "http://localhost:11434/v1",
    });
    expect(local?.endpoint).toBe("http://localhost:11434/v1");
    expect(local?.apiKey).toBeUndefined();
  });

  it('mori#121: an explicitly-empty MEMORIZE_EMBEDDINGS_MODEL/ENDPOINT falls back to the default, not ""', () => {
    // `MEMORIZE_EMBEDDINGS_MODEL=` (empty assignment), a docker-compose YAML
    // null, or an unset CI secret injection all produce "" here, not undefined
    // — `??` would let it through and silently disable the model filter in
    // listEmbeddings (mori#121).
    const resolved = resolveEmbeddingsConfig({
      MEMORIZE_EMBEDDINGS_API_KEY: "k",
      MEMORIZE_EMBEDDINGS_ENDPOINT: "",
      MEMORIZE_EMBEDDINGS_MODEL: "",
    });
    expect(resolved?.model).toBe(DEFAULT_EMBEDDINGS_MODEL);
    expect(resolved?.endpoint).toBe(DEFAULT_EMBEDDINGS_ENDPOINT);
  });
});

describe("getEmbedder", () => {
  it("builds an Embedder from config and reports its model", () => {
    const embedder = getEmbedder({ endpoint: "http://x/v1", model: "text-embedding-3-small" });
    expect(embedder?.model).toBe("text-embedding-3-small");
  });

  it("returns undefined when unconfigured, so the kernel gets an explicit off", () => {
    // Resolve against an EMPTY env, not `undefined` — passing undefined would
    // fire getEmbedder's `= resolveEmbeddingsConfig()` default and read the
    // ambient process.env, so the case would flip on any machine that happens
    // to export MEMORIZE_EMBEDDINGS_* (PR #90 review).
    expect(getEmbedder(resolveEmbeddingsConfig({}))).toBeUndefined();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { getEmbedder } from "./index.js";
import { resolveEmbeddingsConfig } from "./config.js";

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
});

describe("getEmbedder", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds an Embedder from config and reports its model", () => {
    const embedder = getEmbedder({ endpoint: "http://x/v1", model: "text-embedding-3-small" });
    expect(embedder?.model).toBe("text-embedding-3-small");
  });

  it("returns undefined when explicitly resolved off, without falling back to ambient env", () => {
    // resolveEmbeddingsConfig({}) itself evaluates to `undefined` — passing
    // that through is indistinguishable from omitting the argument to a
    // defaulted parameter, which is exactly why getEmbedder takes `config`
    // as a rest tuple instead: `configArg.length > 0` here is 1, so the
    // explicit `undefined` is honored rather than re-reading process.env
    // (see index.ts's doc comment; PR #90 review raised this failure mode).
    expect(getEmbedder(resolveEmbeddingsConfig({}))).toBeUndefined();
  });

  it("an explicit off is not flipped back on by ambient env (PR #90 review, #122)", () => {
    vi.stubEnv("MEMORIZE_EMBEDDINGS_ENDPOINT", "http://ambient/v1");
    expect(getEmbedder(resolveEmbeddingsConfig({}))).toBeUndefined();
  });
});

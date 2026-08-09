import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BENCH_CACHE_DIR_ENV, resolveBenchCacheDir } from "./bench-cache-dir.js";

describe("resolveBenchCacheDir (#422)", () => {
  it("prefers the --cache-dir argument over everything else", () => {
    expect(resolveBenchCacheDir("/explicit/cache", { [BENCH_CACHE_DIR_ENV]: "/env/cache" })).toBe(
      "/explicit/cache",
    );
  });

  it("falls back to MORI_BENCH_CACHE_DIR when no argument is given", () => {
    expect(resolveBenchCacheDir(undefined, { [BENCH_CACHE_DIR_ENV]: "/env/cache" })).toBe(
      "/env/cache",
    );
  });

  it("falls back to $XDG_CACHE_HOME/mori/bench/llm-cache when neither is given", () => {
    expect(resolveBenchCacheDir(undefined, { XDG_CACHE_HOME: "/xdg-cache" })).toBe(
      join("/xdg-cache", "mori", "bench", "llm-cache"),
    );
  });

  it("falls back to ~/.cache/mori/bench/llm-cache when nothing at all is set", () => {
    const resolved = resolveBenchCacheDir(undefined, {});
    expect(resolved).toMatch(/[/\\]\.cache[/\\]mori[/\\]bench[/\\]llm-cache$/);
  });
});

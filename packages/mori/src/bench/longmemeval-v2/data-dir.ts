import { homedir } from "node:os";
import { join } from "node:path";

export const LMEV2_DATA_DIR_ENV = "MORI_BENCH_LMEV2_DATA_DIR";

/**
 * Resolves where a local LongMemEval-V2 snapshot lives — `MORI_BENCH_LMEV2_DATA_DIR` env var >
 * `$XDG_CACHE_HOME/mori/bench/longmemeval-v2` (falling back to `~/.cache/mori/bench/
 * longmemeval-v2`), mirroring `cache/bench-cache-dir.ts`'s `resolveBenchCacheDir` convention.
 * The dataset itself (Apache-2.0, ~7GB with screenshots) is never committed to this repo —
 * `fetch-dataset.ts` populates this directory on demand.
 */
export function resolveLongMemEvalDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[LMEV2_DATA_DIR_ENV]?.trim();
  if (fromEnv) return fromEnv;
  const cacheHome = env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(cacheHome, "mori", "bench", "longmemeval-v2");
}

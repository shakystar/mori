import { homedir } from "node:os";
import { join } from "node:path";

export const LMEV1_DATA_DIR_ENV = "MORI_BENCH_LMEV1_DATA_DIR";

/**
 * Resolves where a local LongMemEval(v1, `longmemeval-cleaned`) snapshot lives —
 * `MORI_BENCH_LMEV1_DATA_DIR` env var > `$XDG_CACHE_HOME/mori/bench/longmemeval-v1` (falling
 * back to `~/.cache/mori/bench/longmemeval-v1`), mirroring `longmemeval-v2/data-dir.ts`'s
 * `resolveLongMemEvalDataDir` convention (itself mirroring `cache/bench-cache-dir.ts`). The
 * dataset itself (MIT, ≈277MB for `longmemeval_s_cleaned.json`) is never committed to this
 * repo — `fetch-dataset.ts` populates this directory on demand.
 */
export function resolveLongMemEvalV1DataDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[LMEV1_DATA_DIR_ENV]?.trim();
  if (fromEnv) return fromEnv;
  const cacheHome = env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(cacheHome, "mori", "bench", "longmemeval-v1");
}

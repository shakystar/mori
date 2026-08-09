import { homedir } from "node:os";
import { join } from "node:path";

export const BENCH_CACHE_DIR_ENV = "MORI_BENCH_CACHE_DIR";

/**
 * Resolves the persistent directory a bench run's `FileLlmCallCacheStore` (#372) should live
 * in — `--cache-dir` argument > `MORI_BENCH_CACHE_DIR` env var > `$XDG_CACHE_HOME/mori/bench/
 * llm-cache` (falling back to `~/.cache/mori/bench/llm-cache`), mirroring
 * `credential-store.ts`'s `defaultCredentialsPath` XDG convention. #422: callers that used to
 * `mkdtemp` this directory made every rerun pay full price again — a fixed path is what makes
 * the cache (keyed on model+context+params, not on run identity) actually reusable across runs.
 */
export function resolveBenchCacheDir(
  argValue: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (argValue) return argValue;
  const fromEnv = env[BENCH_CACHE_DIR_ENV]?.trim();
  if (fromEnv) return fromEnv;
  const cacheHome = env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(cacheHome, "mori", "bench", "llm-cache");
}

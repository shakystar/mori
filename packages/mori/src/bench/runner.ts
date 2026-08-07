import type { spawn as nodeSpawn } from "node:child_process";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type BenchAxis } from "./axes.js";
import { FileLlmCallCacheStore, sweepOrphanCacheTmpFiles } from "./cache/file-cache-store.js";
import type { LlmCallCacheHooks } from "./cache/llm-call-cache.js";
import { createCostLedger, writeCostReport, type CostLedger, type CostReport } from "./cost-ledger.js";
import { createReader, resolveReaderExecutionPath, type Reader, type ReaderExecutionPath } from "./reader.js";

export interface BenchRunnerConfig {
  /** Directory `FileLlmCallCacheStore` (#372) persists reader replies to. A prior run's
   * crashed write can leave `<key>.json.tmp-<uuid>` orphans here — `createBenchRunner` sweeps
   * them once at startup (file-cache-store.ts's `sweepOrphanCacheTmpFiles`) before the cache
   * is used, per the runner-owns-the-cache-dir's-lifetime decision recorded there. */
  cacheDir: string;
  model: Model<Api>;
  /** Real provider call for the `"api"` reader path. Ignored on `"claude-cli"`. */
  streamFn: StreamFn;
  /** Defaults to `resolveReaderExecutionPath(env)` — see reader.ts for the env var. */
  readerPath?: ReaderExecutionPath;
  /** `"claude-cli"` path only: cwd for the subprocess (defaults through `resolveReaderCwd` to
   * a neutral temp dir — never the repo root) and the executable to invoke. */
  claudeCliCwd?: string;
  claudeCliCommand?: string;
  /** Test seam: `child_process.spawn` substitute for the `"claude-cli"` path. */
  claudeCliSpawn?: typeof nodeSpawn;
  /** Axis the `"api"` reader's usage is recorded under (#373's `CostLedger`, keyed through
   * `axes.ts`'s shared constants). Defaults to `BENCH_AXES.cost` inside `reader.ts`. */
  costAxis?: BenchAxis;
  systemPrompt?: string;
  /** Test/observability seam surfaced straight through to `withLlmCallCache` (#372) — a bench
   * can wire counters/loggers here without reaching into the cache module directly. */
  cacheHooks?: LlmCallCacheHooks;
}

export interface BenchRunner {
  /** The reader/analysis-pass entry point (#374's own scope) — cache- and cost-ledger-backed
   * on the `"api"` path, a `claude -p` subprocess on `"claude-cli"`. */
  reader: Reader;
  /** #373's per-run accumulator. Exposed directly so a bench can `record()` its own axes
   * (e.g. mori session turns, which run on their own product-path `streamFn`, unrelated to
   * reader path selection) alongside whatever the reader records. */
  costLedger: CostLedger;
  /** Snapshots the ledger and, if `path` is given, persists it via #373's `writeCostReport`. */
  finish(path?: string): Promise<CostReport>;
}

/**
 * Builds the #374 common runner: sweeps the cache directory, wires a reader for the selected
 * execution path (#372's cache + #373's cost ledger on the `"api"` path), and hands back both
 * plus a `finish()` that closes out the run's cost report. Bench-specific protocols (#343–345)
 * build their episode logic on top of this — this module owns none of that.
 */
export async function createBenchRunner(
  config: BenchRunnerConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BenchRunner> {
  await sweepOrphanCacheTmpFiles(config.cacheDir);
  const cacheStore = new FileLlmCallCacheStore(config.cacheDir);
  const costLedger = createCostLedger();
  const path = config.readerPath ?? resolveReaderExecutionPath(env);

  const reader = await createReader(
    path === "api"
      ? {
          path,
          api: {
            model: config.model,
            streamFn: config.streamFn,
            cacheStore,
            ...(config.cacheHooks === undefined ? {} : { cacheHooks: config.cacheHooks }),
            costLedger,
            ...(config.costAxis === undefined ? {} : { costAxis: config.costAxis }),
            ...(config.systemPrompt === undefined ? {} : { systemPrompt: config.systemPrompt }),
          },
        }
      : {
          path,
          claudeCli: {
            ...(config.claudeCliCwd === undefined ? {} : { cwd: config.claudeCliCwd }),
            ...(config.claudeCliCommand === undefined ? {} : { command: config.claudeCliCommand }),
            ...(config.claudeCliSpawn === undefined ? {} : { spawn: config.claudeCliSpawn }),
          },
        },
  );

  return {
    reader,
    costLedger,
    async finish(path?: string): Promise<CostReport> {
      const report = costLedger.report();
      if (path) await writeCostReport(report, path);
      return report;
    },
  };
}

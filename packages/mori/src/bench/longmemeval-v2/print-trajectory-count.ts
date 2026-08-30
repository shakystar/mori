#!/usr/bin/env node
import { isMainEntry } from "../../cli/entrypoint.js";
import { resolveLongMemEvalDataDir } from "./data-dir.js";
import { loadTrajectories } from "./loader.js";

/**
 * The reproduction command #503's feasibility doc points at — loads `trajectories.jsonl` from a
 * real, previously-fetched LongMemEval-V2 snapshot (see `fetch-dataset.ts`) and prints the total
 * trajectory count plus the elapsed time and peak RSS `loadTrajectories` took to build them, so a
 * reader can check §1's numbers against a committed script instead of a temporary one that never
 * made it into the repo.
 */
export async function printTrajectoryCount(
  dataDir: string,
  io: { stdout: (chunk: string) => void } = { stdout: (c) => process.stdout.write(c) },
): Promise<void> {
  const start = process.hrtime.bigint();
  const trajectories = await loadTrajectories(dataDir);
  const elapsedSeconds = Number(process.hrtime.bigint() - start) / 1e9;
  const peakRssMb = process.resourceUsage().maxRSS / 1024;
  io.stdout(`trajectories: ${String(trajectories.length)}\n`);
  io.stdout(`elapsed: ${elapsedSeconds.toFixed(1)}s\n`);
  io.stdout(`peak rss: ${String(Math.round(peakRssMb))} MB\n`);
}

if (isMainEntry(process.argv[1], import.meta.url)) {
  printTrajectoryCount(resolveLongMemEvalDataDir()).catch((error: unknown) => {
    process.stderr.write(
      `longmemeval-v2: 궤적 수 출력 실패 — ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

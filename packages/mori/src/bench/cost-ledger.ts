import fs from "node:fs/promises";
import path from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { sumUsage } from "../session.js";

/**
 * Per-run usage/cost accumulator for a bench episode (#342 조각 2/4). A bench runner calls
 * `record` once per turn with the axis that turn's cost counts toward — the dashboard
 * categories from discussion #327 (주입 적중률, 재증류율, 재질문율) plus this issue's own
 * "비용" axis, and #242's retrieval-quality axis once it lands. `axis` is a caller-chosen
 * string, not a fixed enum, so a new axis is a new call site, never a change to this file.
 */
export interface CostLedger {
  /** Adds one turn's `Usage` (see `MoriSessionTurn.usage`, session.ts) to `axis`'s running total. */
  record(axis: string, usage: Usage): void;
  /** A snapshot of every `record` call so far: the run's combined usage and each axis's own share. */
  report(): CostReport;
}

export interface CostReport {
  /** Usage — cost included (`Usage.cost`) — summed across every axis recorded so far. */
  total: Usage;
  /** Usage summed per axis, keyed by whatever name callers passed to `record`. */
  byAxis: Record<string, Usage>;
}

export function createCostLedger(): CostLedger {
  const byAxis = new Map<string, Usage[]>();

  return {
    record(axis: string, usage: Usage): void {
      const usages = byAxis.get(axis);
      if (usages) usages.push(usage);
      else byAxis.set(axis, [usage]);
    },
    report(): CostReport {
      const entries = [...byAxis.entries()];
      return {
        total: sumUsage(entries.flatMap(([, usages]) => usages)),
        byAxis: Object.fromEntries(entries.map(([axis, usages]) => [axis, sumUsage(usages)])),
      };
    },
  };
}

/** Persists a `CostReport` as pretty-printed JSON, creating parent directories as needed. */
export async function writeCostReport(report: CostReport, filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

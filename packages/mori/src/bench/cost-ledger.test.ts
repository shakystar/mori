import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createCostLedger, writeCostReport } from "./cost-ledger.js";

function usage(partial: Partial<Usage> & { cost: Usage["cost"] }): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    ...partial,
  };
}

describe("createCostLedger", () => {
  it("sums multiple turns' usage into a matching total and per-axis cost", () => {
    const ledger = createCostLedger();

    ledger.record(
      "injection-hit-rate",
      usage({
        input: 100,
        output: 20,
        totalTokens: 120,
        cost: { input: 10, output: 6, cacheRead: 0, cacheWrite: 0, total: 16 },
      }),
    );
    ledger.record(
      "injection-hit-rate",
      usage({
        input: 50,
        output: 10,
        totalTokens: 60,
        cost: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, total: 8 },
      }),
    );
    ledger.record(
      "re-question-rate",
      usage({
        input: 200,
        output: 40,
        cacheRead: 30,
        totalTokens: 270,
        cost: { input: 20, output: 12, cacheRead: 3, cacheWrite: 0, total: 35 },
      }),
    );

    const report = ledger.report();

    // Per-axis: each axis's usage is the sum of only the turns recorded under it.
    expect(report.byAxis["injection-hit-rate"]).toEqual(
      usage({
        input: 150,
        output: 30,
        totalTokens: 180,
        cost: { input: 15, output: 9, cacheRead: 0, cacheWrite: 0, total: 24 },
      }),
    );
    expect(report.byAxis["re-question-rate"]).toEqual(
      usage({
        input: 200,
        output: 40,
        cacheRead: 30,
        totalTokens: 270,
        cost: { input: 20, output: 12, cacheRead: 3, cacheWrite: 0, total: 35 },
      }),
    );

    // Run total: sum across every axis, not just the last one recorded (correctness bar this
    // issue's completion criteria names explicitly).
    expect(report.total).toEqual(
      usage({
        input: 350,
        output: 70,
        cacheRead: 30,
        totalTokens: 450,
        cost: { input: 35, output: 21, cacheRead: 3, cacheWrite: 0, total: 59 },
      }),
    );
  });

  it("reports an empty run as zeroed totals with no axes", () => {
    const report = createCostLedger().report();

    expect(report.byAxis).toEqual({});
    expect(report.total.cost.total).toBe(0);
    expect(report.total.totalTokens).toBe(0);
  });

  it("keeps an axis unaffected by turns recorded under a different axis", () => {
    const ledger = createCostLedger();
    ledger.record(
      "re-distillation-rate",
      usage({ cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 } }),
    );
    ledger.record(
      "injection-hit-rate",
      usage({ cost: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, total: 2 } }),
    );

    const report = ledger.report();

    expect(report.byAxis["re-distillation-rate"]?.cost.total).toBe(1);
    expect(report.byAxis["injection-hit-rate"]?.cost.total).toBe(2);
    expect(report.total.cost.total).toBe(3);
  });

  it("adding a new axis name at a call site requires no change to the ledger's own code — the map is open, not a fixed enum", () => {
    const ledger = createCostLedger();
    ledger.record(
      "retrieval-quality",
      usage({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } }),
    );

    expect(Object.keys(ledger.report().byAxis)).toEqual(["retrieval-quality"]);
  });
});

describe("writeCostReport", () => {
  it("persists the report as JSON, creating parent directories as needed", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mori-cost-report-"));
    try {
      const ledger = createCostLedger();
      ledger.record(
        "injection-hit-rate",
        usage({ cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } }),
      );
      const report = ledger.report();
      const filePath = path.join(dir, "nested", "report.json");

      await writeCostReport(report, filePath);

      const written = JSON.parse(await fs.readFile(filePath, "utf8"));
      expect(written).toEqual(report);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

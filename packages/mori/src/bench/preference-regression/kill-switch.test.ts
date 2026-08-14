import { describe, expect, it } from "vitest";
import { computeKillSwitchReport, KILL_SWITCH_GAP_THRESHOLD } from "./kill-switch.js";
import type { ScenarioRunResult } from "./runner.js";

function fixtureResult(
  condition: ScenarioRunResult["condition"],
  score: number,
): ScenarioRunResult {
  return {
    scenarioId: "s1",
    scenarioTitle: "fixture",
    condition,
    followUpOutput: "reply",
    score: { scenarioId: "s1", criteria: [], score },
    injected: false,
    reQuestioned: undefined,
    compactionSummary: undefined,
  };
}

describe("computeKillSwitchReport (#435)", () => {
  it("judges a scenario invalid, at both the scenario and the aggregate level, when the ORACLE-OFF gap is within the threshold", () => {
    const results: ScenarioRunResult[] = [
      fixtureResult("oracle", 0.5),
      fixtureResult("memory-off", 0.5),
    ];

    const report = computeKillSwitchReport(results);

    expect(report.threshold).toBe(KILL_SWITCH_GAP_THRESHOLD);
    expect(report.scenarios).toEqual([
      { scenarioId: "s1", oracleScore: 0.5, offScore: 0.5, gap: 0, invalid: true },
    ]);
    expect(report.invalid).toBe(true);
  });
});

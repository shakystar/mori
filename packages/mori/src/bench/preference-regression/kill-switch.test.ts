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
      {
        scenarioId: "s1",
        oracleScore: 0.5,
        offScore: 0.5,
        gap: 0,
        sampleSizes: { oracle: 1, off: 1 },
        invalid: true,
      },
    ]);
    expect(report.invalid).toBe(true);
  });

  it("averages repeated results for the same (scenario, condition) instead of judging off the first one (nightly-slice repeats, #401)", () => {
    // A single unlucky repeat (oracle=0, off=0 → gap=0) sits among nine others that clearly
    // separate — averaging must not let that one repeat drag the whole scenario invalid.
    const results: ScenarioRunResult[] = [
      fixtureResult("oracle", 0),
      fixtureResult("memory-off", 0),
      ...Array.from({ length: 9 }, () => fixtureResult("oracle", 1)),
      ...Array.from({ length: 9 }, () => fixtureResult("memory-off", 0)),
    ];

    const report = computeKillSwitchReport(results);

    // oracle mean = (0 + 9*1)/10 = 0.9, off mean = 0 → gap = 0.9, well above threshold.
    expect(report.scenarios).toEqual([
      {
        scenarioId: "s1",
        oracleScore: 0.9,
        offScore: 0,
        gap: 0.9,
        sampleSizes: { oracle: 10, off: 10 },
        invalid: false,
      },
    ]);
    expect(report.invalid).toBe(false);
  });

  it("records each arm's sample size so an unbalanced gap is diagnosable after the fact (owner review, PR #444)", () => {
    // ORACLE ran 10 repeats, OFF only 2 — the gap here is real (1.0 vs 0.0) but a reader of the
    // report cannot tell balanced from unbalanced averages unless the counts are carried along.
    const results: ScenarioRunResult[] = [
      ...Array.from({ length: 10 }, () => fixtureResult("oracle", 1)),
      ...Array.from({ length: 2 }, () => fixtureResult("memory-off", 0)),
    ];

    const report = computeKillSwitchReport(results);

    expect(report.scenarios[0]?.sampleSizes).toEqual({ oracle: 10, off: 2 });
    // 표본 불균형은 기록만 한다 — 판정은 여전히 gap으로만 선다.
    expect(report.scenarios[0]?.invalid).toBe(false);
  });
});

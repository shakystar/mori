import { describe, expect, it } from "vitest";
import type { ScenarioRunResult } from "./runner.js";
import { computeSampleStats } from "./sample-stats.js";

function fixtureResult(
  scenarioId: string,
  condition: ScenarioRunResult["condition"],
  score: number,
): ScenarioRunResult {
  return {
    scenarioId,
    scenarioTitle: "fixture",
    condition,
    followUpOutput: "reply",
    score: { scenarioId, criteria: [], score },
    injected: false,
    injectedContent: undefined,
    reQuestioned: undefined,
    compactionSummary: undefined,
    fallbackUsed: undefined,
  };
}

describe("computeSampleStats (#469)", () => {
  it("summarizes each (scenario, arm)'s repeats as n + mean + dispersion", () => {
    const results = [
      fixtureResult("s1", "memory-off", 0),
      fixtureResult("s1", "memory-off", 1),
      fixtureResult("s1", "memory-off", 0.5),
      fixtureResult("s1", "oracle", 1),
    ];

    const [scenario] = computeSampleStats(results);

    expect(scenario?.scenarioId).toBe("s1");
    expect(scenario?.arms).toEqual([
      {
        condition: "memory-off",
        n: 3,
        mean: 0.5,
        stdDev: Math.sqrt((0.25 + 0.25 + 0) / 3),
        min: 0,
        max: 1,
      },
      // n=1 reports 0 dispersion rather than NaN — see `ScoreSummary.stdDev`.
      { condition: "oracle", n: 1, mean: 1, stdDev: 0, min: 1, max: 1 },
    ]);
  });

  it("leaves out an arm that never ran instead of showing it as a zero-score row", () => {
    const stats = computeSampleStats([fixtureResult("s1", "memory-on", 0.5)]);

    expect(stats[0]?.arms.map((arm) => arm.condition)).toEqual(["memory-on"]);
  });
});

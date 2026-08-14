import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { KILL_SWITCH_GAP_THRESHOLD } from "./kill-switch.js";
import { reportNightlySliceOutcome } from "./nightly-slice-cli.js";
import type { NightlySliceReport } from "./nightly-slice.js";
import type { ScenarioRunResult } from "./runner.js";

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fixtureScenarioResult(): ScenarioRunResult {
  return {
    scenarioId: "s1",
    scenarioTitle: "fixture",
    condition: "memory-on",
    followUpOutput: "reply",
    score: { scenarioId: "s1", criteria: [], score: 1 },
    injected: true,
    reQuestioned: true,
    compactionSummary: undefined,
  };
}

function fixtureReport(
  scenarios: readonly ScenarioRunResult[],
  killSwitch?: NightlySliceReport["killSwitch"],
): NightlySliceReport {
  return {
    total: ZERO_USAGE,
    byAxis: {},
    repeatsPerScenario: 10,
    scenarios,
    axisRates: { injectionHitRate: 0, reDistillationRate: 0, reQuestionRate: 0 },
    killSwitch: killSwitch ?? {
      threshold: KILL_SWITCH_GAP_THRESHOLD,
      scenarios: [],
      invalid: false,
    },
  };
}

function fakeIo(): {
  stdout: string[];
  stderr: string[];
  io: { stdout: (c: string) => void; stderr: (c: string) => void };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (chunk: string) => stdout.push(chunk),
      stderr: (chunk: string) => stderr.push(chunk),
    },
  };
}

describe("reportNightlySliceOutcome (#416: 0건 그린 구멍)", () => {
  it("returns 0 when at least one scenario ran", () => {
    const { stdout, stderr, io } = fakeIo();

    const code = reportNightlySliceOutcome(
      fixtureReport([fixtureScenarioResult()]),
      "bench-reports/out.json",
      io,
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("")).toContain("시나리오 결과 1건");
  });

  it("returns 1 and surfaces the reason on stderr when zero scenarios ran", () => {
    const { stderr, io } = fakeIo();

    const code = reportNightlySliceOutcome(fixtureReport([]), "bench-reports/out.json", io);

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("실행된 시나리오가 0건이다");
  });

  it("returns 1 and surfaces the invalid scenarios on stderr when the kill switch fires (#435)", () => {
    const { stderr, io } = fakeIo();

    const code = reportNightlySliceOutcome(
      fixtureReport([fixtureScenarioResult()], {
        threshold: KILL_SWITCH_GAP_THRESHOLD,
        scenarios: [{ scenarioId: "s1", oracleScore: 0.5, offScore: 0.5, gap: 0, invalid: true }],
        invalid: true,
      }),
      "bench-reports/out.json",
      io,
    );

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("킬 스위치 발동");
    expect(stderr.join("")).toContain("s1(gap=0)");
  });
});

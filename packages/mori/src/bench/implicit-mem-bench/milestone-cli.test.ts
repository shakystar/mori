import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { reportMilestoneOutcome } from "./milestone-cli.js";
import type { MilestoneReport } from "./milestone.js";

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fixtureReport(batchFailures: MilestoneReport["batchFailures"]): MilestoneReport {
  return {
    total: ZERO_USAGE,
    byAxis: {},
    scenarios: [],
    axisRates: { injectionHitRate: 0, reDistillationRate: 0, reQuestionRate: 0 },
    batchFailures,
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

describe("reportMilestoneOutcome (#407 owner 수정요청)", () => {
  it("returns 0 and writes no stderr when the batch had no failures", () => {
    const { stdout, stderr, io } = fakeIo();

    const code = reportMilestoneOutcome(fixtureReport([]), "bench-reports/out.json", io);

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("")).toContain("시나리오 결과 0건");
  });

  it("returns 1 and surfaces the failing custom_id(s) on stderr when batch items failed", () => {
    const { stderr, io } = fakeIo();
    const report = fixtureReport([
      { customId: "rubric::s1::memory-on::judge-criterion", error: "expired" },
    ]);

    const code = reportMilestoneOutcome(report, "bench-reports/out.json", io);

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("rubric::s1::memory-on::judge-criterion(expired)");
    expect(stderr.join("")).toContain("1건");
  });
});

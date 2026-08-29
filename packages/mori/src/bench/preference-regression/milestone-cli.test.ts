import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { KILL_SWITCH_GAP_THRESHOLD } from "./kill-switch.js";
import { reportMilestoneOutcome, runMilestoneCli } from "./milestone-cli.js";
import type { MilestoneReport } from "./milestone.js";
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
    injectedContent: "fixture injected content",
    reQuestioned: true,
    compactionSummary: undefined,
    fallbackUsed: false,
  };
}

function fixtureReport(overrides: {
  scenarios?: readonly ScenarioRunResult[];
  judgeBatchRequests?: number;
  batchFailures?: MilestoneReport["batchFailures"];
  killSwitch?: MilestoneReport["killSwitch"];
}): MilestoneReport {
  return {
    total: ZERO_USAGE,
    byAxis: {},
    scenarios: overrides.scenarios ?? [fixtureScenarioResult()],
    axisRates: { injectionHitRate: 0, reDistillationRate: 0, reQuestionRate: 0 },
    batchFailures: overrides.batchFailures ?? [],
    judgeBatchRequests: overrides.judgeBatchRequests ?? 1,
    judgeBatchSubmitted: overrides.judgeBatchRequests ?? 1,
    killSwitch: overrides.killSwitch ?? {
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

describe("reportMilestoneOutcome (#407 owner 수정요청, #416)", () => {
  it("returns 0 and writes no stderr on a normal run (scenarios >=1, requests >=1, no failures)", () => {
    const { stdout, stderr, io } = fakeIo();

    const code = reportMilestoneOutcome(fixtureReport({}), "bench-reports/out.json", io);

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("")).toContain("시나리오 결과 1건");
  });

  it("returns 1 and surfaces the failing custom_id(s) on stderr when batch items failed", () => {
    const { stderr, io } = fakeIo();
    const report = fixtureReport({
      batchFailures: [{ customId: "rubric::s1::memory-on::judge-criterion", error: "expired" }],
    });

    const code = reportMilestoneOutcome(report, "bench-reports/out.json", io);

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("rubric::s1::memory-on::judge-criterion(expired)");
    expect(stderr.join("")).toContain("1건");
  });

  it("returns 1 when zero scenarios ran (#416: 0건 그린 구멍)", () => {
    const { stderr, io } = fakeIo();
    const report = fixtureReport({ scenarios: [] });

    const code = reportMilestoneOutcome(report, "bench-reports/out.json", io);

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("실행된 시나리오가 0건이다");
  });

  it("returns 1 when judgeBatchRequests is zero even though scenarios ran (#416: 0건 그린 구멍)", () => {
    const { stderr, io } = fakeIo();
    const report = fixtureReport({ judgeBatchRequests: 0 });

    const code = reportMilestoneOutcome(report, "bench-reports/out.json", io);

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("judge 배치 요청이 0건이다");
  });

  it("returns 1 when the kill switch judges any scenario invalid (#435)", () => {
    const { stderr, io } = fakeIo();
    const report = fixtureReport({
      killSwitch: {
        threshold: KILL_SWITCH_GAP_THRESHOLD,
        scenarios: [
          {
            scenarioId: "s1",
            oracleScore: 0.5,
            offScore: 0.5,
            gap: 0,
            sampleSizes: { oracle: 1, off: 1 },
            invalid: true,
          },
        ],
        invalid: true,
      },
    });

    const code = reportMilestoneOutcome(report, "bench-reports/out.json", io);

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("킬 스위치 발동");
    expect(stderr.join("")).toContain("s1(gap=0)");
  });
});

describe("runMilestoneCli (#452: MORI_CONSOLIDATE_MODEL 미설정이면 memory-on 팔이 조용히 0으로 샌다)", () => {
  it("fails before running any episode when MORI_CONSOLIDATE_MODEL is unset", async () => {
    const { stderr, io } = fakeIo();

    // `env`에 인증·프로바이더 정보를 아예 안 넣는다 — 이 가드가 그보다 먼저 걸린다면
    // 이후 어떤 실 I/O(credential store, Batch API 인증 해석)도 건드리지 않았다는 뜻이다.
    const code = await runMilestoneCli([], {}, io);

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("MORI_CONSOLIDATE_MODEL");
  });
});

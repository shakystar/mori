import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunCliDeps } from "../../cli/types.js";
import type { CreateMoriSessionResult, MoriSessionTurn } from "../../session.js";
import { KILL_SWITCH_GAP_THRESHOLD } from "./kill-switch.js";
import {
  reportNightlySliceOutcome,
  runNightlySliceCli,
  runNightlySliceWithPartialFlush,
} from "./nightly-slice-cli.js";
import type { NightlySliceReport } from "./nightly-slice.js";
import type { CreateSessionFn, ScenarioRunResult } from "./runner.js";
import type { PreferenceRegressionScenario } from "./scenarios.js";

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

function fixtureReport(
  scenarios: readonly ScenarioRunResult[],
  killSwitch?: NightlySliceReport["killSwitch"],
): NightlySliceReport {
  return {
    total: ZERO_USAGE,
    byAxis: {},
    repeatsPerScenario: 10,
    completedRepeats: 10,
    scenarios,
    axisRates: { injectionHitRate: 0, reDistillationRate: 0, reQuestionRate: 0 },
    rubricVersion: 2,
    // 이 CLI의 판정은 표본 요약(#469)을 읽지 않는다 — 종료 코드는 아래 킬 스위치·건수
    // 가드로만 갈리므로 픽스처는 비워 둔다.
    sampleStats: [],
    // 기본값은 **판정이 실제로 선** 회차다 — ORACLE·OFF가 둘 다 돌아 간격이 임계값을 넘긴
    // 시나리오 1건. `scenarios: []`(판정 0건)를 기본값으로 두면 그 자체가 아래 0건 가드에
    // 걸리므로, 그 상태는 전용 케이스에서만 만든다.
    killSwitch: killSwitch ?? {
      threshold: KILL_SWITCH_GAP_THRESHOLD,
      scenarios: [
        {
          scenarioId: "s1",
          oracleScore: 1,
          offScore: 0,
          gap: 1,
          sampleSizes: { oracle: 1, off: 1 },
          invalid: false,
        },
      ],
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

  it("returns 1 when scenarios ran but the kill switch judged none of them (#401)", () => {
    const { stderr, io } = fakeIo();

    // 시나리오는 돌았는데 킬 스위치 판정은 0건 — ORACLE·OFF가 함께 실행된 시나리오가 없어
    // `computeKillSwitchReport`가 전부 건너뛴 모양이다. `invalid`는 `some([])`라 `false`이므로,
    // 가드가 없으면 이 회차가 그린으로 새어 나간다.
    const code = reportNightlySliceOutcome(
      fixtureReport([fixtureScenarioResult()], {
        threshold: KILL_SWITCH_GAP_THRESHOLD,
        scenarios: [],
        invalid: false,
      }),
      "bench-reports/out.json",
      io,
    );

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("킬 스위치가 판정한 시나리오가 0건이다");
  });

  it("returns 1 and surfaces the invalid scenarios on stderr when the kill switch fires (#435)", () => {
    const { stderr, io } = fakeIo();

    const code = reportNightlySliceOutcome(
      fixtureReport([fixtureScenarioResult()], {
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
      }),
      "bench-reports/out.json",
      io,
    );

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("킬 스위치 발동");
    expect(stderr.join("")).toContain("s1(gap=0)");
  });
});

describe("runNightlySliceCli (#452: MORI_CONSOLIDATE_MODEL 미설정이면 memory-on 팔이 조용히 0으로 샌다)", () => {
  it("fails before running any episode when MORI_CONSOLIDATE_MODEL is unset", async () => {
    const { stderr, io } = fakeIo();

    // `env`에 인증·프로바이더 정보를 아예 안 넣는다 — 이 가드가 그보다 먼저 걸린다면
    // 이후 어떤 실 I/O(credential store, 모델 해석)도 건드리지 않았다는 뜻이다.
    const code = await runNightlySliceCli([], {}, io);

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("MORI_CONSOLIDATE_MODEL");
  });
});

function fixtureModel(): Model<Api> {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
}

function fixtureUsage(): Usage {
  return {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
  };
}

/** Answers every prompt with a fixed judge verdict — see runner.test.ts's identical fixture. */
function fakeJudgeStreamFn(): StreamFn {
  return async () => {
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "예, 그렇다." }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: fixtureUsage(),
      stopReason: "stop",
      timestamp: 0,
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    return stream;
  };
}

function fixturePreferenceScenario(): PreferenceRegressionScenario {
  return {
    id: "solo",
    title: "fixture-solo",
    contextTurns: ["ctx-1"],
    followUpPrompt: "follow-up prompt",
    impliedPreference: "some preference — never surfaced to a judge prompt",
    rubric: [
      {
        kind: "deterministic",
        id: "nonempty",
        description: "출력이 비어있지 않다",
        check: (output) => output.length > 0,
      },
    ],
  };
}

/** #512: `createSession` stub that fails the very first turn of any repeat whose scratch root
 * contains `rep-1` (`nightly-slice.ts` joins `workRoot`/`memorizeRootBase` with `rep-<i>` per
 * repeat) — mirrors `assertTurnOk`'s real failure shape (runner.ts:200) rather than throwing
 * directly, so the test exercises the same "loud fail mid-loop" path #504 hit in production. */
function fakeSessionFailingOnRepeat(repToFail: number): CreateSessionFn {
  return (_env: NodeJS.ProcessEnv, deps: RunCliDeps): Promise<CreateMoriSessionResult> => {
    const shouldFail = (deps.root ?? "").includes(`rep-${String(repToFail)}`);
    return Promise.resolve({
      ok: true,
      session: {
        async prompt(text: string): Promise<MoriSessionTurn> {
          if (shouldFail) return { text: "", stopReason: "error", usage: fixtureUsage() };
          return { text: `reply:${text}`, stopReason: "stop", usage: fixtureUsage() };
        },
        consolidate: () => Promise.resolve({ kind: "ok" as const }),
        compact: () =>
          Promise.resolve({ summary: "fixture compaction summary", usage: fixtureUsage() }),
        close: () => Promise.resolve({ usage: fixtureUsage() }),
      },
    });
  };
}

describe("runNightlySliceWithPartialFlush (#512: 회차 중간 체크포인트)", () => {
  let cacheDir: string;
  let workRoot: string;
  let memorizeRootBase: string;
  let out: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "mori-nightly-slice-cache-"));
    workRoot = await mkdtemp(join(tmpdir(), "mori-nightly-slice-work-"));
    memorizeRootBase = await mkdtemp(join(tmpdir(), "mori-nightly-slice-store-"));
    out = join(await mkdtemp(join(tmpdir(), "mori-nightly-slice-out-")), "report.json");
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
    await rm(workRoot, { recursive: true, force: true });
    await rm(memorizeRootBase, { recursive: true, force: true });
  });

  it("flushes the partial report and rethrows when a repeat fails mid-loop", async () => {
    const { io } = fakeIo();

    await expect(
      runNightlySliceWithPartialFlush(
        {
          model: fixtureModel(),
          streamFn: fakeJudgeStreamFn(),
          cacheDir,
          workRoot,
          memorizeRootBase,
          scenarios: [fixturePreferenceScenario()],
          conditions: ["memory-off"],
          repeatsPerScenario: 3,
          createSession: fakeSessionFailingOnRepeat(1),
        },
        out,
        io,
      ),
    ).rejects.toThrow(/맥락 턴이 실패했다/);

    const written = JSON.parse(await readFile(out, "utf8")) as NightlySliceReport;
    expect(written.completedRepeats).toBe(1);
  });
});

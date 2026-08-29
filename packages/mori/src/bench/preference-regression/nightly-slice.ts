import path from "node:path";
import type { Api, CredentialStore, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createCostLedger, type CostReport } from "../cost-ledger.js";
import { computeKillSwitchReport, type KillSwitchReport } from "./kill-switch.js";
import { computeSampleStats, type ScenarioSampleStats } from "./sample-stats.js";
import {
  computeAxisRates,
  runPreferenceRegression,
  type CreateKernelFn,
  type CreateSessionFn,
  type PreferenceRegressionCondition,
  type ScenarioRunResult,
} from "./runner.js";
import {
  PREFERENCE_REGRESSION_RUBRIC_VERSION,
  type PreferenceRegressionScenario,
} from "./scenarios.js";

const SLICE_REPEATS_ENV = "MORI_BENCH_SLICE_REPEATS";

/** memorize#176 선례 — 시나리오(타입)당 10회 반복, 시나리오 3종 기준 memory-on n=30. */
export const DEFAULT_SLICE_REPEATS_PER_SCENARIO = 10;

/** `MORI_BENCH_SLICE_REPEATS`를 읽는다. 미설정 시 `DEFAULT_SLICE_REPEATS_PER_SCENARIO`.
 * `runNightlySliceCli`(nightly-slice-cli.ts)의 `--repeats`가 이 값보다 우선한다. */
export function resolveSliceRepeatsPerScenario(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SLICE_REPEATS_ENV];
  if (raw === undefined) return DEFAULT_SLICE_REPEATS_PER_SCENARIO;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `mori bench: 알 수 없는 슬라이스 반복 횟수 "${raw}" (${SLICE_REPEATS_ENV}). 1 이상의 정수여야 한다.`,
    );
  }
  return parsed;
}

export interface NightlySliceOptions {
  model: Model<Api>;
  streamFn: StreamFn;
  /** #372 캐시 스토어 디렉터리. 이 실행 전용이어야 한다 — 아래 `runNightlySlice` 문서 참고. */
  cacheDir: string;
  /** 반복마다 `workRoot/rep-<i>` 하위에 격리된 스크래치 디렉터리를 쓴다. */
  workRoot: string;
  /** 반복마다 `memorizeRootBase/rep-<i>` 하위에 격리된 스토어 루트를 쓴다. */
  memorizeRootBase: string;
  env?: NodeJS.ProcessEnv;
  credentialStore?: CredentialStore;
  scenarios?: readonly PreferenceRegressionScenario[];
  conditions?: readonly PreferenceRegressionCondition[];
  systemPrompt?: string;
  /** 기본값 `resolveSliceRepeatsPerScenario(env)`. */
  repeatsPerScenario?: number;
  createSession?: CreateSessionFn;
  createKernel?: CreateKernelFn;
}

export interface NightlySliceReport extends CostReport {
  repeatsPerScenario: number;
  scenarios: readonly ScenarioRunResult[];
  axisRates: ReturnType<typeof computeAxisRates>;
  /** ORACLE−OFF 간격 킬 스위치 판정(#435) — milestone.ts의 `MilestoneReport.killSwitch`와 같은
   * 자리. milestone-cli.ts는 judge 채점에 Anthropic Batch API를 강제하므로(#340 §3) DeepSeek
   * 등 다른 프로바이더로는 돌릴 수 없다 — 실비용 API 경로에서 이 판정을 실제로 낼 수 있는
   * 것은 이 리포트뿐이다(#401). */
  killSwitch: KillSwitchReport;
  /** `PREFERENCE_REGRESSION_RUBRIC_VERSION`(scenarios.ts, #475) 그대로 — 반복마다 부르는
   * `runPreferenceRegression`이 전부 같은 값을 실어 오므로 슬라이스 전체를 대표한다. */
  rubricVersion: number;
  /** 시나리오별 × 팔별 표본 요약(n·평균·표준편차·최소·최대) — #469 요구 3. `killSwitch`의 판정이
   * 딛고 선 평균이 어떤 표본에서 나왔는지를 같은 리포트 안에서 읽게 한다(둘 다 `sample-stats.ts`의
   * 같은 추출·요약을 쓴다). */
  sampleStats: readonly ScenarioSampleStats[];
}

/**
 * 나이틀리/주간 슬라이스 — #397의 3계층 케이든스 중 "고정 슬라이스, 실비용 API 경로" 층
 * (#406, #397 조각 2/3). `runPreferenceRegression`(#387)를 시나리오 세트당 `repeatsPerScenario`회
 * 반복 호출해 memorize#176 선례의 표본 크기(per-type 10, n=30)를 만든다. 나이틀리·주간은
 * 실행 빈도만 다를 뿐 같은 스크립트를 쓴다 — 이 파일에 별도 분기는 없다.
 *
 * 반복마다 `runPreferenceRegression`를 별도 `workRoot`/`memorizeRoot`로 호출하는 이유: 그 함수
 * 자체가 "호출마다 비어있는 새 디렉터리"를 요구한다(runner.ts의 `PreferenceRegressionOptions.workRoot`
 * 문서) — 같은 루트를 재사용하면 이전 반복이 응고한 기억이 다음 반복의 후속 세션에 새어
 * 들어간다. `runPreferenceRegression`가 실행 동안 `MEMORIZE_ROOT`를 프로세스 전역으로 바꾸는 것도
 * 동시 호출을 막으므로(같은 문서), 반복은 항상 순차로 돈다.
 *
 * `cacheDir`는 호출자가 실행마다(예: 매 크론 잡마다) 새로 만들어 넘겨야 한다 — 이 층의 존재
 * 이유가 "회당 수$~수십$"의 실측 신호이기 때문에, 여러 밤에 걸쳐 캐시를 재사용하면 이튿날부터
 * 같은 프롬프트가 캐시로 재생돼(#372) PR 스모크 층(#405)과 구분이 없어진다. 한 실행 내
 * 반복끼리는 이 디렉터리를 공유해도 안전하다 — 판정 패스(judge) 같은 우연한 중복 호출만
 * 캐시 적중으로 절약되고, 맥락/후속 세션 본문은 반복마다 새 스토어를 쓰므로 캐시 키(모델,
 * 프롬프트, 파라미터)가 겹치지 않는다.
 */
export async function runNightlySlice(options: NightlySliceOptions): Promise<NightlySliceReport> {
  const env = options.env ?? process.env;
  const repeatsPerScenario = options.repeatsPerScenario ?? resolveSliceRepeatsPerScenario(env);

  const scenarioResults: ScenarioRunResult[] = [];
  const ledger = createCostLedger();

  for (let rep = 0; rep < repeatsPerScenario; rep++) {
    const report = await runPreferenceRegression({
      model: options.model,
      streamFn: options.streamFn,
      cacheDir: options.cacheDir,
      workRoot: path.join(options.workRoot, `rep-${rep}`),
      memorizeRoot: path.join(options.memorizeRootBase, `rep-${rep}`),
      // #469: 회차 인덱스를 캐시 키에 싣는 유일한 지점. 이것이 없으면 회차마다 새 `workRoot`·
      // `memorizeRoot`를 줘도 표본이 늘지 않는다 — 스크래치 루트는 캐시 키에서 정규화돼 빠지고
      // (`llm-call-cache.ts`의 `normalizeVolatilePaths`), judge 프롬프트는 회차 간 같아질 수
      // 있어서 2회차 이후가 1회차 판정을 그대로 재생한다.
      repeatIndex: rep,
      env,
      ...(options.credentialStore ? { credentialStore: options.credentialStore } : {}),
      ...(options.scenarios ? { scenarios: options.scenarios } : {}),
      ...(options.conditions ? { conditions: options.conditions } : {}),
      ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
      ...(options.createSession ? { createSession: options.createSession } : {}),
      ...(options.createKernel ? { createKernel: options.createKernel } : {}),
    });
    scenarioResults.push(...report.scenarios);
    for (const [axis, usage] of Object.entries(report.byAxis)) {
      ledger.record(axis, usage);
    }
  }

  return {
    ...ledger.report(),
    repeatsPerScenario,
    scenarios: scenarioResults,
    axisRates: computeAxisRates(scenarioResults),
    killSwitch: computeKillSwitchReport(scenarioResults),
    rubricVersion: PREFERENCE_REGRESSION_RUBRIC_VERSION,
    sampleStats: computeSampleStats(scenarioResults),
  };
}

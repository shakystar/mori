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
  /** #512: 회차 하나가 끝날 때마다(설정돼 있으면) 그 시점까지의 부분 리포트로 호출된다 —
   * 루프 도중 예외가 나도 마지막으로 완료된 회차분은 호출자가 이미 손에 쥔 상태가 되게 한다. */
  onRepeatComplete?: (
    partial: NightlySliceReport,
    completedRepeats: number,
  ) => Promise<void> | void;
}

export interface NightlySliceReport extends CostReport {
  repeatsPerScenario: number;
  /** #512: 실제로 끝까지 돈 회차 수. 완주 시 `repeatsPerScenario`와 같다 — 루프 도중 예외로
   * 중단됐을 때 소비자가 부분/완주를 구분하는 유일한 필드다. */
  completedRepeats: number;
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
 *
 * ## 재실행이 캐시를 타지 않는 잔여 호출 — 세션종료 증류 (#473)
 *
 * `--repeats N`을 **같은** `cacheDir`로 두 번 실행하면(회차 인덱스가 같은 회차끼리 재생되므로)
 * 이제 맥락/후속 세션 턴도 캐시를 탄다(#473 — 이 함수가 `runPreferenceRegression`에 넘기는
 * `streamFn`이 그 함수 내부에서 `cacheStore`로 감싸진다). 그래도 재생 0건은 아니다: `"memory-on"`
 * 팔의 세션종료 증류(`close()`가 트리거하는 `consolidateOnSessionEnd` → `PiConsolidatorLlm.complete()`)
 * 는 여전히 실호출이다. 이유는 우회가 아니라 **아예 다른 provider를 거치기 때문**이다 —
 * `PiConsolidatorLlm.complete()`는 이 함수가 넘긴 `streamFn`이 아니라
 * `Models#completeSimple`(`cli/runtime.ts`의 `getConsolidatorLlm(models, resolveConsolidatorConfig(env))`)을
 * 부르고, 세션 턴이 캐시를 타게 만드는 장치(`createMoriAgent`의 `overrideProviderStream`,
 * `agent/fake-provider-models.ts`)는 `resolveProviderSelection(env)`가 고른 **메인 모델의
 * provider 하나만** 실 스트림을 교체한다. `MORI_CONSOLIDATE_MODEL`(예: 값싼 증류 전용 모델)이
 * 메인 모델과 다른 provider를 가리키면(`model-wiring.ts`의 `moriProviders`가 anthropic·openai·
 * deepseek을 모두 무조건 등록해 두는 것이 정확히 이런 조합을 위해서다) 그 provider의 진짜
 * `stream`/`streamSimple`은 이 함수가 만드는 그 무엇의 손도 닿지 않는다.
 *
 * 이걸 캐시에 태우려면 이 벤치가 `Models`를 직접 만들어(`createMoriModels`) 증류 provider까지
 * 스스로 찾아 오버라이드하고, 그 인스턴스를 세션마다 `RunCliDeps.models`(현재는 테스트 전용
 * 시드로만 쓰이는 자리 — `cli/types.ts`)로 주입해야 한다 — `prepareAgent`가 인증 게이트와 실제
 * 턴에 "같은 인스턴스"를 쓰는 것을 보장하는 그 정체성 계약을 프로덕션 벤치 경로까지 늘리는
 * 일이라, "옵션 하나 더 넘긴다"는 이번 배선보다 훨씬 큰 변경이다. 그 비용 대비 실제 노출은
 * 작다 — 증류는 실제 mori 커널을 만드는 `"memory-on"` 팔에서만 일어나고(`"memory-off"`·
 * `"oracle"`의 스토어 없는 커널 더블은 `consolidate()`가 순수 no-op이다), 세션 하나당 최대
 * 1건(세션종료 1회)이라 (시나리오 × repeat) 쌍당 최대 2건(맥락 세션 종료 + 후속 세션 종료)이고,
 * `BENCH_AXES.sessionEndDistillation`이라는 별도 축에 이미 항목별로 잡혀 리포트에서 숨지
 * 않는다. 그래서 지금은 태우지 않는다.
 *
 * ## 재실행이 캐시를 타지 않는 잔여 호출 (2) — 도구 재실행이 만드는 연쇄 미스 (#473)
 *
 * 위 증류 호출만으로는 실측을 설명하지 못한다. 1개 시나리오·`--repeats 2`·3팔을 같은
 * `cacheDir`로 연속 2회 실행한 실측(#473 PR #484 후속 코멘트)은 1회차 38건 → 2회차 8건이었고,
 * 8건 중 증류로 귀속되는 것은 일부일 뿐이다(같은 실측에서 `MORI_CONSOLIDATE_MODEL`을 메인
 * 모델과 같은 provider로 둬도 남았다 — 즉 provider 불일치가 원인이 아닌 잔여가 있다). 심지어
 * `"memory-on"`을 빼고 `"memory-off"`·`"oracle"` 두 팔만 돌려도(증류 자체가 없는 조합) 재실행에
 * 미스가 남았다.
 *
 * 원인은 **캐시가 LLM 호출만 감싸고, 그 응답이 트리거하는 실제 도구 실행까지는 감싸지 않는다는
 * 것**이다. 재생된(캐시 hit) assistant 메시지에 `tool_call`(예: 하네스가 스스로 판단해 부르는
 * `bash("ls -la")`)이 실려 있으면, 에이전트 루프는 그 도구를 실행마다 실제로 다시 돈다 — 캐시는
 * "모델이 무엇을 만들었는가"만 재생하지 "도구가 무엇을 돌려줬는가"는 재생하지 않는다. 그 결과가
 * 실행마다 달라지면(관측 사례: `ls -la` 출력의 mtime 컬럼 — 새로 만든 `mkdtemp` 디렉터리라
 * 매 실행 실제 벽시계 시각이 다르다) 그 지점부터 컨텍스트가 갈라져 같은 에피소드의 나머지 호출
 * 전부가 연쇄로 캐시 밖이 된다: 그 세션의 다음 턴들, 그리고 그 턴의 출력(`followUpOutput`)에
 * 기대는 judge 판정(`scoringJudge`/`reQuestionJudge`, `runPreferenceRegressionScenario`)까지.
 *
 * 이 mtime은 `dropMessageTimestamps`가 다루는 `Message.timestamp` 필드가 아니라 도구 결과
 * *content* 안의 임의 텍스트이고, `normalizeVolatilePaths`가 다루는 "호출자가 선언한 경로
 * 문자열"도 아니다 — 날짜처럼 보이는 텍스트를 휴리스틱으로 지우는 정규화는
 * `dropMessageTimestamps`의 주석이 이미 명시적으로 피한 방향이다(서로 다른 두 도구 결과를 같은
 * 키로 접어 버리는, 캐시에서 더 비싼 쪽의 오류). 그래서 여기서도 같은 이유로 정규화를 추가하지
 * 않는다 — 도구를 실제로 실행하는 세션은 구조적으로 "재실행 API 호출 0건"을 보장할 수 없다.
 * `"memory-on"` 고유의 현상도 아니다 — 하네스가 스스로 탐색성 도구를 부르는 시나리오라면
 * `"memory-off"`·`"oracle"`도 같은 연쇄를 탄다(위 실측). 재실행 후 남는 실호출이 있다면 그
 * 정체는 이 문단과 위 문단(증류) 둘 중 하나다 — 어느 쪽인지는 시나리오가 도구를 부르는지,
 * `"memory-on"`이 섞여 있는지로 갈라 보면 된다.
 */
export async function runNightlySlice(options: NightlySliceOptions): Promise<NightlySliceReport> {
  const env = options.env ?? process.env;
  const repeatsPerScenario = options.repeatsPerScenario ?? resolveSliceRepeatsPerScenario(env);

  const scenarioResults: ScenarioRunResult[] = [];
  const ledger = createCostLedger();

  const buildReport = (completedRepeats: number): NightlySliceReport => ({
    ...ledger.report(),
    repeatsPerScenario,
    completedRepeats,
    scenarios: [...scenarioResults],
    axisRates: computeAxisRates(scenarioResults),
    killSwitch: computeKillSwitchReport(scenarioResults),
    rubricVersion: PREFERENCE_REGRESSION_RUBRIC_VERSION,
    sampleStats: computeSampleStats(scenarioResults),
  });

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
    const completedRepeats = rep + 1;
    await options.onRepeatComplete?.(buildReport(completedRepeats), completedRepeats);
  }

  return buildReport(repeatsPerScenario);
}

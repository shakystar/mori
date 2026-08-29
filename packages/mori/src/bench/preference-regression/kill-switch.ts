import type { PreferenceRegressionCondition, ScenarioRunResult } from "./runner.js";
import { armScoreSamples, summarizeScores } from "./sample-stats.js";

/**
 * 킬 스위치(#435, discussion #343 owner 지시 5) — ORACLE(정답을 통째로 준 팔)과 OFF(하네스
 * 압축 요약만 받은 팔)의 점수가 이 값 미만으로 벌어지면, 그 시나리오는 "정답을 알아도 점수가
 * 안 오른다"는 뜻이라 무효로 판정한다.
 *
 * `scorer.ts`의 `ScenarioScore.score`는 만족한 루브릭 항목 수 / 유효 항목 수(0~1)다. 「유효 항목 수」는
 * 전체 항목 수가 아니라 `"inconclusive"`(#475, deterministic 기준이 판정할 증거를 못 찾은 경우)를 뺀
 * 수라, 시나리오·회차마다 다를 수 있다 — `scenarios.ts`의 시나리오는 전부 루브릭이 deterministic 1개 +
 * llm-judge 1개이고 llm-judge는 항상 유효하므로(judge는 예/아니오로만 답한다), 유효 항목 수는 1
 * (deterministic이 inconclusive인 회차) 아니면 2(둘 다 유효인 회차)다. 어느 쪽이든 그 항목 수에서
 * 나올 수 있는 점수는 {0, 1} 또는 {0, 0.5, 1}뿐이고, 두 경우 모두 두 점수 사이에 존재할 수 있는 가장
 * 작은 0이 아닌 차이는 0.5(항목 하나)다 — 0과 0.5 사이의 값은 이 점수 척도에서 애초에 나올 수 없다.
 * 임계값을 그 최소 유효 간격의 절반(0.25)으로 둔다: 이 값 미만은 "루브릭 항목이 단 하나도 안 갈렸다"
 * (갭이 정확히 0)와 동치이고, 이 값 이상이면 최소 한 항목이 실제로 갈렸다는 뜻이라 신호로 인정한다.
 * 루브릭이 커져 점수 척도가 더 촘촘해져도(항목이 4개면 최소 step은 0.25) 이 임계값은 여전히 그보다
 * 엄격한 쪽에 남는다 — 임의로 고른 숫자가 아니라 현재 점수 척도의 최소 해상도에서 유도했다.
 *
 * 이 산출은 유효 항목 수가 0이 될 수 없다는 데 기댄다: 지금은 시나리오마다 llm-judge가 최소 1개 있어
 * 항상 바닥에 걸리지만, deterministic 기준만으로 이뤄진 시나리오가 새로 추가되면 그 시나리오의 유효
 * 항목 수가 0까지 내려갈 수 있다 — 그때는 이 산출이 다시 성립하지 않으므로 임계값을 재산출할 것.
 */
export const KILL_SWITCH_GAP_THRESHOLD = 0.25;

export interface KillSwitchScenarioVerdict {
  scenarioId: string;
  oracleScore: number;
  offScore: number;
  /** `oracleScore - offScore`. 음수면 OFF가 ORACLE을 앞섰다는 뜻이고, 그 경우도 임계값 미만과
   * 마찬가지로 무효다 — 정답을 준 팔이 못 준 팔보다 못하다면 그 자체가 채점 신뢰성 문제다. */
  gap: number;
  /** 각 팔의 평균에 쓰인 표본 수. 어긋나면 gap이 표본 불균형의 산물일 수 있다 — 반복 실행에서
   * 한 팔의 일부 회차만 실패해 스킵되면 서로 다른 크기의 표본끼리 평균이 비교되고, 그때
   * "간격이 임계값을 넘었다/못 넘었다"는 판정이 실제 신호가 아니라 불균형의 산물일 수 있다.
   * 판정 자체는 이 값으로 바꾸지 않는다(무엇이 옳은 보정인지 이 데이터만으로는 정할 수 없다) —
   * 리포트에 남겨 사후 진단이 가능하게만 한다. */
  sampleSizes: { oracle: number; off: number };
  invalid: boolean;
}

export interface KillSwitchReport {
  threshold: number;
  /** ORACLE·OFF 두 팔이 모두 돌아 간격을 잴 수 있었던 시나리오만 담는다 — 한쪽 팔이 애초에
   * 안 돌았으면(예: `conditions`를 좁혀 실행) 그 시나리오는 판정 대상에서 빠진다(무효로 치지
   * 않는다, 잴 수 없었을 뿐이다). */
  scenarios: readonly KillSwitchScenarioVerdict[];
  /** 시나리오 중 하나라도 무효면 전체도 무효다 — 평균으로 묻으면 셋 중 하나만 고장 난 경우가
   * 집계에 가려진다(#435 완료 조건: 시나리오별·전체 집계 둘 다에 판정이 있어야 한다). */
  invalid: boolean;
}

/** 같은 (시나리오, 조건) 쌍의 점수를 평균한다 — 마일스톤(milestone.ts)은 조건당 결과가 항상
 * 하나라 평균이 그 값 그대로지만, 나이틀리/주간 슬라이스(nightly-slice.ts)는 `repeatsPerScenario`
 * 회 반복된 결과가 전부 같은 (시나리오, 조건) 키로 쌓인다. 첫 건만 보면(`.find()`) 반복 10회 중
 * 1회의 우연한 저점으로 전체가 무효 판정될 수 있다 — 평균이 그 표본 크기를 실제로 쓴다.
 *
 * 표본 추출·요약 자체는 `sample-stats.ts`에 있다(#469): 리포트 표의 팔별 평균이 여기 판정과 같은
 * 표본 위에서 나온 값임을 「같은 함수를 쓴다」로 보장하기 위해서다 — 표 각주가 그렇게 적는다. */
function scoreFor(
  results: readonly ScenarioRunResult[],
  scenarioId: string,
  condition: PreferenceRegressionCondition,
): { mean: number; sampleSize: number } | undefined {
  const summary = summarizeScores(armScoreSamples(results, scenarioId, condition));
  if (summary === undefined) return undefined;
  return { mean: summary.mean, sampleSize: summary.n };
}

/**
 * `results`(여러 시나리오 × 조건 실행 결과, 반복 실행이면 같은 키가 여러 번 나타날 수 있다)에서
 * 시나리오별·전체 킬 스위치 판정을 계산한다. ORACLE·OFF 두 팔의 점수만 읽는다 —
 * `computeAxisRates`(runner.ts)의 세 축은 분모가 `"memory-on"` 팔 하나로 고정돼 있어(#440 이후)
 * 이 계산과 성격이 다르다. 그래서 `axisRates` 자리에 얹지 않고 이 모듈을 따로 둔다(#435 게이트
 * 코멘트).
 */
export function computeKillSwitchReport(results: readonly ScenarioRunResult[]): KillSwitchReport {
  const scenarioIds = [...new Set(results.map((r) => r.scenarioId))];

  const scenarios: KillSwitchScenarioVerdict[] = [];
  for (const scenarioId of scenarioIds) {
    const oracle = scoreFor(results, scenarioId, "oracle");
    const off = scoreFor(results, scenarioId, "memory-off");
    if (oracle === undefined || off === undefined) continue;

    const gap = oracle.mean - off.mean;
    scenarios.push({
      scenarioId,
      oracleScore: oracle.mean,
      offScore: off.mean,
      gap,
      sampleSizes: { oracle: oracle.sampleSize, off: off.sampleSize },
      invalid: gap < KILL_SWITCH_GAP_THRESHOLD,
    });
  }

  return {
    threshold: KILL_SWITCH_GAP_THRESHOLD,
    scenarios,
    invalid: scenarios.some((s) => s.invalid),
  };
}

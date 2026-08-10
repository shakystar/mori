import type { PreferenceRegressionCondition, ScenarioRunResult } from "./runner.js";

/**
 * 킬 스위치(#435, discussion #343 owner 지시 5) — ORACLE(정답을 통째로 준 팔)과 OFF(하네스
 * 압축 요약만 받은 팔)의 점수가 이 값 미만으로 벌어지면, 그 시나리오는 "정답을 알아도 점수가
 * 안 오른다"는 뜻이라 무효로 판정한다.
 *
 * `scorer.ts`의 `ScenarioScore.score`는 만족한 루브릭 항목 수 / 전체 항목 수(0~1)다. 이 임계값을
 * 정한 시점 기준 `scenarios.ts`의 시나리오는 전부 루브릭이 정확히 2항목이라, 두 점수 사이에
 * 존재할 수 있는 가장 작은 0이 아닌 차이는 0.5(항목 하나)다 — 0과 0.5 사이의 값은 이 점수
 * 척도에서 애초에 나올 수 없다. 임계값을 그 최소 유효 간격의 절반(0.25)으로 둔다: 이 값 미만은
 * "루브릭 항목이 단 하나도 안 갈렸다"(갭이 정확히 0)와 동치이고, 이 값 이상이면 최소 한 항목이
 * 실제로 갈렸다는 뜻이라 신호로 인정한다. 루브릭이 커져 점수 척도가 더 촘촘해져도(항목이 4개면
 * 최소 step은 0.25) 이 임계값은 여전히 그보다 엄격한 쪽에 남는다 — 임의로 고른 숫자가 아니라
 * 현재 점수 척도의 최소 해상도에서 유도했다.
 */
export const KILL_SWITCH_GAP_THRESHOLD = 0.25;

export interface KillSwitchScenarioVerdict {
  scenarioId: string;
  oracleScore: number;
  offScore: number;
  /** `oracleScore - offScore`. 음수면 OFF가 ORACLE을 앞섰다는 뜻이고, 그 경우도 임계값 미만과
   * 마찬가지로 무효다 — 정답을 준 팔이 못 준 팔보다 못하다면 그 자체가 채점 신뢰성 문제다. */
  gap: number;
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

function scoreFor(
  results: readonly ScenarioRunResult[],
  scenarioId: string,
  condition: PreferenceRegressionCondition,
): number | undefined {
  return results.find((r) => r.scenarioId === scenarioId && r.condition === condition)?.score.score;
}

/**
 * `results`(여러 시나리오 × 조건 실행 결과)에서 시나리오별·전체 킬 스위치 판정을 계산한다.
 * ORACLE·OFF 두 팔의 점수만 읽는다 — `computeAxisRates`(runner.ts)의 세 축은 분모가
 * `"memory-on"` 팔 하나로 고정돼 있어(#440 이후) 이 계산과 성격이 다르다. 그래서 `axisRates`
 * 자리에 얹지 않고 이 모듈을 따로 둔다(#435 게이트 코멘트).
 */
export function computeKillSwitchReport(results: readonly ScenarioRunResult[]): KillSwitchReport {
  const scenarioIds = [...new Set(results.map((r) => r.scenarioId))];

  const scenarios: KillSwitchScenarioVerdict[] = [];
  for (const scenarioId of scenarioIds) {
    const oracleScore = scoreFor(results, scenarioId, "oracle");
    const offScore = scoreFor(results, scenarioId, "memory-off");
    if (oracleScore === undefined || offScore === undefined) continue;

    const gap = oracleScore - offScore;
    scenarios.push({
      scenarioId,
      oracleScore,
      offScore,
      gap,
      invalid: gap < KILL_SWITCH_GAP_THRESHOLD,
    });
  }

  return {
    threshold: KILL_SWITCH_GAP_THRESHOLD,
    scenarios,
    invalid: scenarios.some((s) => s.invalid),
  };
}

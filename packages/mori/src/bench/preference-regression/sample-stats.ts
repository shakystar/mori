import {
  PREFERENCE_REGRESSION_CONDITIONS,
  type PreferenceRegressionCondition,
  type ScenarioRunResult,
} from "./runner.js";

/**
 * 반복 표본 요약 (#469 요구 3). `--repeats`를 올려 같은 (시나리오, 팔)을 여러 번 돌려도, 지금까지
 * 리포트 표에 남는 것은 점수 하나뿐이었다 — 읽는 사람은 그 값이 n=1인지 n=10인지, 회차끼리
 * 갈렸는지 전부 같았는지 알 수 없었다. 킬 스위치는 이미 평균 위에서 판정하는데(kill-switch.ts)
 * 표에는 그 평균의 표본 크기·산포가 없어, 「gap이 0.02였다」가 «잴 수 있는 신호가 없다»인지
 * «표본이 너무 작다»인지 구분되지 않는다. 이 모듈이 그 표본 정보를 리포트에 실어 나른다.
 */

export interface ScoreSummary {
  /** 이 (시나리오, 팔)에 실제로 남은 에피소드 레코드 수. 팔마다 다를 수 있다 — 반복 중 일부
   * 회차가 실패해 빠지면 여기서 드러난다(`KillSwitchScenarioVerdict.sampleSizes`와 같은 이유). */
  n: number;
  mean: number;
  /**
   * **모집단** 표준편차(n으로 나눈다). 표본표준편차(n−1)를 쓰지 않는 이유는 이 값이 추정량이
   * 아니라 관측 기술(記述)이기 때문이다: 여기 담기는 것은 이 회차에 실제로 돌린 에피소드 전부이고,
   * 읽는 사람이 표에서 알고 싶은 것은 「그 회차들이 서로 갈렸는가」다. n−1을 쓰면 n=1에서 0/0이
   * 되어 `NaN`이 표에 실리는데, `--repeats 1`이 이 벤치의 기본 사용법이라 그 칸은 매번 비게 된다 —
   * 산포를 보여주려고 만든 열이 가장 흔한 경우에 아무것도 못 보여주는 셈이다. n=1이면 0이 맞다:
   * 「이 하나의 관측 안에서는 갈릴 것이 없었다」이고, 그 옆의 `n`이 그것이 단 한 번의 관측임을
   * 이미 말해 준다.
   */
  stdDev: number;
  min: number;
  max: number;
}

export interface ArmSampleStats extends ScoreSummary {
  condition: PreferenceRegressionCondition;
}

export interface ScenarioSampleStats {
  scenarioId: string;
  /** 결과에 실제로 나타난 팔만, `PREFERENCE_REGRESSION_CONDITIONS` 순서로. 돌지 않은 팔은
   * 0건짜리 칸으로 채우지 않는다 — 「안 돌았다」와 「돌았는데 0점」은 다른 사실이다. */
  arms: readonly ArmSampleStats[];
}

/**
 * 같은 (시나리오, 팔) 키의 점수를 실행 순서대로 뽑는다. 킬 스위치(kill-switch.ts)의 평균과 리포트
 * 표의 평균이 **같은 표본** 위에서 계산되도록 두 곳이 공유하는 단일 지점이다 — 표 각주가
 * 「킬 스위치 판정은 이 평균 기준」이라고 적는 이상, 두 평균이 따로 계산되면 그 각주가 조용히
 * 거짓이 될 수 있다.
 */
export function armScoreSamples(
  results: readonly ScenarioRunResult[],
  scenarioId: string,
  condition: PreferenceRegressionCondition,
): readonly number[] {
  return results
    .filter((r) => r.scenarioId === scenarioId && r.condition === condition)
    .map((r) => r.score.score);
}

/** 표본이 비면 `undefined` — 0건을 평균 0으로 접으면 「안 돌았다」가 「0점을 받았다」로 둔갑한다. */
export function summarizeScores(samples: readonly number[]): ScoreSummary | undefined {
  if (samples.length === 0) return undefined;
  const n = samples.length;
  const mean = samples.reduce((sum, value) => sum + value, 0) / n;
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n;
  return {
    n,
    mean,
    stdDev: Math.sqrt(variance),
    min: Math.min(...samples),
    max: Math.max(...samples),
  };
}

/** 시나리오별 × 팔별 표본 요약. 시나리오 순서는 `results`에 처음 나타난 순서를 따른다
 * (`computeKillSwitchReport`와 같은 규칙이라 두 표를 나란히 읽을 수 있다). */
export function computeSampleStats(
  results: readonly ScenarioRunResult[],
): readonly ScenarioSampleStats[] {
  const scenarioIds = [...new Set(results.map((r) => r.scenarioId))];

  return scenarioIds.map((scenarioId) => ({
    scenarioId,
    arms: PREFERENCE_REGRESSION_CONDITIONS.flatMap((condition) => {
      const summary = summarizeScores(armScoreSamples(results, scenarioId, condition));
      return summary === undefined ? [] : [{ condition, ...summary }];
    }),
  }));
}

/**
 * 선호 유지 회귀 검사(preference regression) 행동 적응 스코어러 (#343 조각 1/4). 시나리오
 * (scenarios.ts)의 후속 세션 출력이 그 시나리오의 `impliedPreference`를 반영했는지 루브릭
 * 기준별로 판정한다. `deterministic` 기준은 이 자리에서 즉시 평가하고, `llm-judge` 기준은
 * 호출자가 주입한 `LlmJudge`로 위임한다 — judge 모델은 호출 지점(#387의 러너 배선)에서
 * 결정되고, 이 모듈은 특정 모델을 하드코딩하지 않는다(memorize#176 선례와 같은 원칙).
 */

/** 후속 세션 출력 텍스트만으로 판정 가능한 기준. `impliedPreference` 라벨이나 맥락 세션
 * 원문은 시그니처에 없다 — 채점기가 정답을 몰래 참조해 우회 판정하는 경로를 타입으로 막는다.
 *
 * `"inconclusive"`(#475): 판정에 쓸 증거 자체가 출력에 없는 경우(예: 들여쓰기 스타일을 재는
 * 기준인데 들여쓴 줄이 아예 없는 출력) — `false`(=위반 증거 있음)와 구분해야 한다. 섞으면
 * "스타일을 안 지켰다"와 "잴 대상이 없었다"가 같은 값으로 뭉개져, 증거 없는 출력이 위반한
 * 출력과 똑같이 벌점을 받는다(mori#475: 코드를 채팅에 인쇄하지 않고 파일에 쓴 응답이 그
 * 이유만으로 "탭을 안 지켰다" 취급을 받은 사례). `scoreBehavioralAdaptation`은
 * `"inconclusive"`를 분자·분모 양쪽에서 제외한다. */
export interface DeterministicCriterion {
  kind: "deterministic";
  id: string;
  description: string;
  check(followUpOutput: string): boolean | "inconclusive";
}

/** LLM-judge에게 위임하는 기준. `question`은 시나리오 작성자가 직접 적는 예/아니오 질문이며,
 * `impliedPreference` 문구를 그대로 노출하지 않도록 쓴다 — judge가 정답 라벨을 그대로
 * 되읽어 순환 판정하는 것을 막기 위해서다. */
export interface LlmJudgeCriterion {
  kind: "llm-judge";
  id: string;
  description: string;
  question: string;
}

export type RubricCriterion = DeterministicCriterion | LlmJudgeCriterion;

export interface LlmJudge {
  /** `question`과 후속 세션 출력을 보고 그 기준이 충족됐는지 예/아니오로 판정한다. 실제 모델
   * 호출은 전적으로 구현체(#387) 몫 — 이 인터페이스는 계약만 정의한다. */
  judge(question: string, followUpOutput: string): Promise<boolean>;
}

export interface ScoreCriterionResult {
  id: string;
  description: string;
  kind: RubricCriterion["kind"];
  /** `"inconclusive"`는 `deterministic` 기준이 판정할 증거를 못 찾았다는 뜻이다(#475) —
   * `score`의 분자·분모 양쪽에서 빠진다. `llm-judge` 기준은 항상 `boolean`이다(judge는 예/아니오로만
   * 답한다, `LlmJudge.judge`의 반환 타입 참고). */
  satisfied: boolean | "inconclusive";
}

export interface ScenarioScore {
  scenarioId: string;
  criteria: readonly ScoreCriterionResult[];
  /** 충족된 루브릭 항목의 비율 (0~1) — `satisfied === "inconclusive"`인 항목은 분자·분모
   * 양쪽에서 뺀다(#475). 루브릭이 비어 있거나, 판정 가능한 항목이 하나도 없으면(전부
   * inconclusive) 0 — "판정 항목 없음"을 "완전 적응"으로 착시하지 않기 위해서다. */
  score: number;
}

/** `scoreBehavioralAdaptation`이 필요로 하는 시나리오의 최소 형태 — `scenarios.ts`의
 * `PreferenceRegressionScenario`를 그대로 받되, 이 모듈이 그 파일을 import하지 않아도 되도록
 * 구조적 타입으로 뽑아둔다(양방향 import 없이 axes→reader→runner와 같은 단방향 의존을 유지). */
export interface ScoredScenario {
  id: string;
  rubric: readonly RubricCriterion[];
}

/**
 * `scenario.rubric`의 각 기준을 후속 세션 출력에 대해 판정하고 충족 비율을 리포트한다.
 * `llm-judge` 기준이 하나라도 있는데 `judge`가 주입되지 않으면, 그 기준을 조용히 스킵해
 * 점수를 왜곡하는 대신 그 자리에서 던진다.
 */
export async function scoreBehavioralAdaptation(
  scenario: ScoredScenario,
  followUpOutput: string,
  judge?: LlmJudge,
): Promise<ScenarioScore> {
  const criteria: ScoreCriterionResult[] = [];

  for (const criterion of scenario.rubric) {
    if (criterion.kind === "deterministic") {
      criteria.push({
        id: criterion.id,
        description: criterion.description,
        kind: "deterministic",
        satisfied: criterion.check(followUpOutput),
      });
      continue;
    }

    if (!judge) {
      throw new Error(
        `mori bench: 시나리오 "${scenario.id}"의 루브릭 항목 "${criterion.id}"는 llm-judge인데 judge가 주입되지 않았다.`,
      );
    }
    criteria.push({
      id: criterion.id,
      description: criterion.description,
      kind: "llm-judge",
      satisfied: await judge.judge(criterion.question, followUpOutput),
    });
  }

  const scorable = criteria.filter((c) => c.satisfied !== "inconclusive");
  const score =
    scorable.length === 0
      ? 0
      : scorable.filter((c) => c.satisfied === true).length / scorable.length;

  return { scenarioId: scenario.id, criteria, score };
}

import type { RubricCriterion } from "./scorer.js";

/**
 * 선호 유지 회귀 검사(preference regression) 시나리오 정의 — discussion #327의 "선호는 kind
 * 선언이 아니라 세션 횡단 재생에서 결과론적으로 석출된다" 명제를 검증하기 위한 최소 시나리오
 * 세트(#343 조각 1/4). 프로토콜(맥락 세션 → 세션 사망 → 후속 세션 관찰)은 arXiv 2604.08064의
 * 설계에서 빌려왔으나 문항은 자체 제작이다 — 이 디렉터리가 논문 벤치가 아닌 이유는
 * `runner.ts` 상단 doc 참고. 이 파일은 순수 데이터 + 타입만 담당한다 — 이 턴들을 실제 mori
 * 세션에 흘리고 consolidation을 거쳐 후속 세션을 실행하는 배선은 러너(#387)의 몫이고, 실측
 * 실행은 #388의 몫이다.
 *
 * 프로토콜 (원 이슈 #343 본문 반영):
 * - `contextTurns`는 맥락 세션의 사용자 발화다. `impliedPreference`를 선언하는 문장(예: "나는
 *   탭을 선호해")은 금지 — 오직 상황·행동으로만 드러나야 leniency 함정(#340 기준 3)을 피한다.
 * - `followUpPrompt`는 별도 세션(맥락 세션은 죽고 mori 스토어의 증류물+retrieval만 남은 상태)
 *   에서 실행되는 과제다. `impliedPreference`를 직접 묻지 않는다 — 명시 질의 없이 행동에
 *   반영돼야 측정 대상(무의식적 행동 적응)이 된다.
 * - `impliedPreference`는 채점에 쓰이는 정답 라벨이다. **ORACLE 팔 하나를 제외하고** 어떤
 *   세션의 컨텍스트에도 주입되지 않는다. 그 예외의 근거는
 *   [2026-08-10 사람 결정](https://github.com/shakystar/mori/issues/343#issuecomment-5237291066)
 *   지시 3·4 — «기억이 완벽했다면 낼 수 있는 점수»라는 천장 팔이 있어야 OFF와의 간격이 «잴 수
 *   있는 폭»이 되기 때문이다(#434). 예외가 그 하나뿐임은 주석이 아니라 코드가 강제한다:
 *   주입 지점은 러너의 `injectOraclePreference`(runner.ts) 하나뿐이고, `"oracle"`이 아닌
 *   조건이 그 경로로 들어오면 던진다. 새 주입 지점을 만들지 말고 그 함수를 거쳐라.
 */
/**
 * 루브릭 판정 *방식*(어떤 기준이 어떻게 satisfied/false/inconclusive를 가르는가)이 바뀌면
 * 올린다 — 프롬프트 문구·주석만 바뀐 것은 대상이 아니다. 리포트(`PreferenceRegressionReport.rubricVersion`,
 * runner.ts)가 이 값을 그대로 실어, 서로 다른 버전의 리포트를 나란히 비교하면 안 된다는 사실을
 * 리포트 파일 스스로 말하게 한다(#475 — 이 필드가 생기기 전 회차는 전부 암묵적 버전 1이다).
 *
 * 버전 2(#475): `uses-tab-indentation`의 결정적 검사가, 들여쓴 줄이 0개인 출력(예: 코드를
 * 채팅에 인쇄하지 않고 파일 저장 도구로만 처리한 응답)을 더 이상 "탭 스타일 위반"(false)으로
 * 채점하지 않는다 — `"inconclusive"`로 처리해 점수 계산에서 제외한다(`scorer.ts`). 이 변경
 * 이전 회차의 `tabs-indentation` 점수는 「채팅에 코드를 인쇄했는가」에 오염돼 있었다.
 */
export const PREFERENCE_REGRESSION_RUBRIC_VERSION = 2;

export interface PreferenceRegressionScenario {
  id: string;
  title: string;
  /** 맥락 세션의 사용자 발화 순서. 마지막 턴 이후 세션은 consolidation을 거쳐 죽는다. */
  contextTurns: readonly string[];
  /** 후속 세션(맥락 세션과 분리된 새 세션)에서 실행되는 과제. */
  followUpPrompt: string;
  /** 채점용 정답 라벨 — ORACLE 팔의 컨텍스트에만 노출된다(위 doc 참고). */
  impliedPreference: string;
  rubric: readonly RubricCriterion[];
}

const TABS_INDENTATION_SCENARIO: PreferenceRegressionScenario = {
  id: "tabs-indentation",
  title: "탭 들여쓰기 되돌림",
  contextTurns: [
    "이 함수 리뷰해줘:\n\n```ts\nfunction add(a: number, b: number) {\n\treturn a + b;\n}\n```",
    "고마워. 근데 방금 네가 예시로 보여준 스니펫 중 하나가 스페이스로 인덴트돼 있길래 내가 다시 고쳤어:\n\n```ts\nfunction subtract(a: number, b: number) {\n\treturn a - b;\n}\n```\n\n이 버전으로 계속 진행해줘.",
    "다음 것도 방금 스타일 그대로 만들어줘: 두 수 중 큰 값을 반환하는 함수.",
  ],
  // 이 과제는 반드시 블록 본문 + 분기를 포함하게 해서 들여쓴 줄이 최소 1줄 나오도록 고정한다.
  // 들여쓴 줄이 0개인 출력은 (#475부터) "inconclusive"로 빠져 벌점을 받지 않지만, 그래도
  // 여기서 증거를 강제해 둔다 — 안 그러면 이 시나리오의 유일한 결정적 기준이 매 회차
  // inconclusive로 빠지고, 채점이 llm-judge 기준 하나에만 의존하게 된다.
  followUpPrompt:
    "두 문자열을 이어붙이는 concat 함수를 TypeScript로 짜줘. 둘 중 한쪽이 빈 문자열이면 " +
    "다른 쪽을 그대로 반환하도록 분기도 넣고, 함수는 블록 본문으로 작성해줘.",
  impliedPreference: "코드 들여쓰기는 탭 문자를 쓴다",
  rubric: [
    {
      kind: "deterministic",
      id: "uses-tab-indentation",
      description: "들여쓰기가 있는 모든 줄이 탭 문자로 시작한다 (스페이스 인덴트 없음)",
      check: (output) => {
        const indentedLines = output.split("\n").filter((line) => /^[\t ]+\S/.test(line));
        // 들여쓴 줄이 0개면 이 기준이 잴 대상 자체가 없다 — 코드를 채팅에 인쇄하지 않고 쓰기
        // 도구로 파일에 저장한 응답이 대표 사례다(mori#470 H3). "false"로 떨어뜨리면 「스타일을
        // 안 지켰다」와 「잴 게 없었다」가 뭉개져 정상 응답 패턴이 벌점을 받는다 — "inconclusive"로
        // 돌려 scorer.ts가 점수 계산에서 빼게 한다.
        if (indentedLines.length === 0) return "inconclusive";
        return indentedLines.every((line) => line.startsWith("\t"));
      },
    },
    {
      kind: "llm-judge",
      id: "matches-formatting-habits",
      description: "전반적 포맷팅이 이전 세션에서 관찰된 사용자 습관과 일치하는가",
      question:
        "다음 코드 스니펫의 들여쓰기 스타일이, 항상 탭으로 인덴트하고 스페이스 인덴트를 볼 때마다 되돌려 온 개발자의 습관과 일치하는가?",
    },
  ],
};

const CONCISE_RESPONSES_SCENARIO: PreferenceRegressionScenario = {
  id: "concise-responses",
  title: "군더더기 없는 답변 선호",
  contextTurns: [
    "이 에러가 왜 나는지 설명해줘: TypeError: Cannot read properties of undefined (reading 'map')",
    "고마워, 근데 결론만 다시 한두 문장으로 줄여줄래.",
    "이번엔 이 워닝은 뭐야: React Hook useEffect has a missing dependency",
    "역시 길다, 짧게.",
  ],
  followUpPrompt: "TypeScript에서 유니언 타입과 인터섹션 타입의 차이가 뭐야?",
  impliedPreference: "설명은 서두 없이 짧고 핵심만 담아야 한다",
  rubric: [
    {
      kind: "deterministic",
      // #459: 원래 기준은 응답 전문(코드 블록 포함)이 200자 이하였다. 이 과제(유니언·인터섹션
      // 차이)는 최소 예시 코드 없이는 정답을 설명하기 어렵고, 그 코드는 "설명이 장황한가"와
      // 무관하게 길이를 채운다 — 실측(2026-08-14 3팔 리포트)에서 ORACLE조차 짧은 코드 예시
      // 하나 때문에 200자를 넘겨 이 기준에 걸렸다(전문 278자, 코드 제외 산문 78자). 코드
      // 펜스를 뺀 산문 길이로 재면 ORACLE(78자)과 장황한 응답(OFF 598자/ON 904자)이 명확히
      // 갈린다 — 임계값을 올리는 대신 "장황함"이 실제로 재려는 대상(산문)만 재도록 고쳤다.
      //
      // 코드 펜스를 통째로 면제하면 반대 우회로가 열린다 — 펜스 안에 주석·문자열로 장황한
      // 설명을 욱여넣은 응답이 "간결함"을 통과해 버린다(PR #461 owner 수정요청 3). 그래서
      // 펜스 내용에도 별도 상한(600자)을 둔다 — ORACLE의 최소 예시(137자)는 여유 있게
      // 통과하고, 펜스에 설명을 우회 삽입한 응답만 걸린다.
      id: "short-response",
      description: "코드 블록을 제외한 설명 산문이 200자 이하이고, 코드 블록 내용도 600자 이하다",
      check: (output) => {
        const fences = output.match(/```[\s\S]*?```/g) ?? [];
        const prose = output.replace(/```[\s\S]*?```/g, "").trim();
        return prose.length <= 200 && fences.join("").length <= 600;
      },
    },
    {
      kind: "llm-judge",
      id: "no-preamble",
      description: "서두 사설 없이 바로 핵심 결론부터 시작하는가",
      question: '이 응답이 서두 사설("좋은 질문이에요" 류) 없이 바로 핵심 결론부터 시작하는가?',
    },
  ],
};

const PNPM_WORKFLOW_SCENARIO: PreferenceRegressionScenario = {
  id: "pnpm-workflow",
  title: "패키지 매니저 pnpm 습관",
  contextTurns: [
    "이 프로젝트 세팅 좀 도와줘. `pnpm install` 돌렸는데 `pnpm-lock.yaml`에 충돌이 나.",
    '빌드는 `pnpm build`로 하고 있어. 이 스크립트도 지금 쓰는 방식 기준으로 다시 써줘:\n\n```json\n{"scripts": {"start": "npm run build && node dist/index.js"}}\n```',
    "고마워.",
  ],
  followUpPrompt: "새 패키지 lodash를 추가하고 싶은데, 설치 명령이랑 CI 스텝 예시를 하나 만들어줘.",
  impliedPreference: "패키지 설치/실행 명령은 pnpm을 쓴다",
  rubric: [
    {
      kind: "deterministic",
      id: "uses-pnpm-command",
      description: "설치 명령에 pnpm을 쓰고 npm/yarn 명령은 섞지 않는다",
      check: (output) => {
        const usesPnpm = /\bpnpm\s+(?:add|install)\b/i.test(output);
        const usesNpm = /\bnpm\s+(?:ci|i|install|run|exec|x)\b/i.test(output);
        const usesYarn = /\byarn\s+(?:add|install)\b/i.test(output);
        return usesPnpm && !usesNpm && !usesYarn;
      },
    },
    {
      kind: "llm-judge",
      id: "ci-step-pnpm-native",
      description: "CI 스텝 예시가 pnpm 워크플로우 관례를 따르는가",
      question:
        "이 CI 스텝 예시가 pnpm 기반 워크플로우 관례(예: corepack 활성화, pnpm 캐시)를 따르고 npm 관례를 섞어 쓰지 않는가?",
    },
  ],
};

export const PREFERENCE_REGRESSION_SCENARIOS: readonly PreferenceRegressionScenario[] = [
  TABS_INDENTATION_SCENARIO,
  CONCISE_RESPONSES_SCENARIO,
  PNPM_WORKFLOW_SCENARIO,
];

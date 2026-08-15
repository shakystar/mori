import fs from "node:fs/promises";
import path from "node:path";
import type { Api, CredentialStore, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { MoriKernel } from "../../agent/index.js";
import type { RunCliDeps } from "../../cli/types.js";
import { createMoriKernel } from "../../kernel/index.js";
import {
  createMoriSession,
  sumUsage,
  type CreateMoriSessionResult,
  type MoriSessionTurn,
} from "../../session.js";
import { BENCH_AXES } from "../axes.js";
import { FileLlmCallCacheStore } from "../cache/file-cache-store.js";
import { withLlmCallCache, type LlmCallCacheStore } from "../cache/llm-call-cache.js";
import type { CostLedger, CostReport } from "../cost-ledger.js";
import { createReader, type Reader } from "../reader.js";
import { createBenchRunner } from "../runner.js";
import { PREFERENCE_REGRESSION_SCENARIOS, type PreferenceRegressionScenario } from "./scenarios.js";
import { scoreBehavioralAdaptation, type LlmJudge, type ScenarioScore } from "./scorer.js";

/**
 * 선호 유지 회귀 검사(preference regression) 러너 배선 (#343 조각 2/4, #387). #386의
 * 시나리오(scenarios.ts)·스코어러(scorer.ts)를 #374의 `createBenchRunner` 위에 얹어
 * "맥락 세션 → 세션 사망 → 후속 세션(이월물만 보고 실행) → 스코어러 호출" 흐름을 실행한다.
 * 그 이월물이 무엇이냐가 팔을 가른다 — `PreferenceRegressionCondition` 참고 (#434).
 * 실제 모델 호출로 진짜 수치를 내는 것은 #388의 몫 — 이 파일은 배선과 리포트 형태까지다.
 *
 * ## 이것은 논문 벤치가 아니다
 *
 * 이 디렉터리는 한때 "ImplicitMemBench"(arXiv 2604.08064)라는 이름을 달고 있었다. 그런데
 * `scenarios.ts`가 실제로 돌리는 것은 이 저장소가 직접 지은 시나리오 3개
 * (`tabs-indentation`·`concise-responses`·`pnpm-workflow`)이지, 그 논문이 말하는 300문항
 * suite가 아니다. 프로토콜(맥락 세션 → 세션 사망 → 후속 세션의 행동 관찰)만 그 논문에서
 * 빌려왔을 뿐, 문항 자체는 자체 제작이다.
 *
 * [2026-08-10 사람 결정](https://github.com/shakystar/mori/issues/343#issuecomment-5236415705)이
 * 이 사실을 근거로 이 축을 **공개 수치 노림수에서 내부 회귀 검사로 격하**했다 — 값싸게 자주
 * 돌려 「메모리 증류가 최소한 하네스 기본 압축 요약보다는 낫다」를 확인하는 용도로만 남긴다.
 * 이 결과는 README·블로그·리더보드 등 **외부로 나가는 수치로 쓰지 않는다.**
 *
 * 이름을 되돌리려는 다음 세션은 여기서 멈춰라 — `ImplicitMemBenchScenario` 류의 식별자를
 * 되살리는 변경은 위 결정과 반대 방향이다.
 */

/**
 * 세 팔 (#434, #343 재정의 조각 3/5). 세 팔은 **후속 세션에 무엇이 이월되는가** 하나만 다르다
 * — 맥락 세션·후속 프롬프트·루브릭·채점은 전부 같다.
 *
 * - `"memory-off"`: 같은 맥락 세션을 보되 남는 것은 **하네스 기본 압축 요약**뿐이다
 *   (mori 증류·retrieval 없음). «mori가 없었으면» 의 정직한 모습.
 * - `"memory-on"`: mori 증류물 + retrieval.
 * - `"oracle"`: `impliedPreference`를 컨텍스트에 직접 주입한 천장.
 *
 * ## OFF가 왜 이 모습이어야 하는가
 *
 * 이 팔은 한때 「맥락 세션을 아예 건너뛰고 빈 스토어에서 곧장 `followUpPrompt`를 실행」했다.
 * [2026-08-10 사람 결정](https://github.com/shakystar/mori/issues/343#issuecomment-5237291066)
 * §2가 그 설계를 물렸다 — 맥락 세션을 건너뛰면 OFF 팔은 선호가 드러난 대화를 **본 적조차 없다.**
 * 그러면 «mori가 이겼다»가 나와도 그것이 재는 것은 «기억 시스템이 좋다»가 아니라 «컨텍스트를
 * 아예 안 준 쪽이 졌다»이고, 어떤 수치가 나와도 #327 명제의 반증이 불가능해진다. 델타를 크게
 * 만드는 베이스라인은 베이스라인이 아니다.
 *
 * ## ORACLE이 왜 필요한가
 *
 * OFF 혼자서는 «간격이 얼마나 벌어질 수 있는지»의 위쪽 끝을 모른다. `impliedPreference`를 직접
 * 주입한 팔이 있어야 ORACLE−OFF가 «잴 수 있는 폭»이 되고, 그 폭이 0이면 시나리오 자체가
 * 무효라는 판정(조각 4의 킬 스위치)이 가능해진다. 그 판정 자체는 이 파일의 몫이 아니다 —
 * 여기서는 세 팔이 돌게만 한다.
 */
export type PreferenceRegressionCondition = "memory-off" | "memory-on" | "oracle";

/** 세 팔의 기본 실행 순서 — `runPreferenceRegression`·`runPreferenceRegressionMilestone`
 * (milestone.ts)가 공유한다. 리터럴을 두 곳에서 따로 적으면 한쪽만 팔이 늘어난 채 조용히
 * 갈라진다 (실제로 #434 전까지 두 파일이 각자 `["memory-on", "memory-off"]`를 적고 있었다). */
export const PREFERENCE_REGRESSION_CONDITIONS: readonly PreferenceRegressionCondition[] = [
  "memory-off",
  "memory-on",
  "oracle",
];

/** 후속 세션 컨텍스트에 얹히는 이월물의 머리말 — 팔마다 다르다. 이월물이 있다는 사실 자체는
 * 모델에게 숨기지 않는다(하네스 압축도 요약임을 표시한 채 컨텍스트에 남는다). */
export const COMPACTION_CARRY_OVER_PREFIX = "[이전 세션의 압축 요약]\n";
export const ORACLE_CARRY_OVER_PREFIX = "[이전 세션에서 드러난 사용자 선호]\n";

/**
 * `impliedPreference`(채점 정답 라벨)가 세션 컨텍스트로 들어가는 **유일한** 지점이다.
 *
 * `scenarios.ts`는 이 라벨의 컨텍스트 주입을 전면 금지하고 있었다. 위 사람 결정 **지시 4**가
 * 그 금지에 예외를 딱 하나 뚫었고 — ORACLE 팔 — 동시에 그 예외가 하나뿐임을 **코드가 강제**할
 * 것을 요구했다. 이 함수가 그 강제다: 주입 경로가 여기 하나뿐이고, `"oracle"`이 아닌 조건이
 * 들어오면 던진다. 주석으로 «다른 팔엔 넣지 마라»라고 적어 두는 것은 강제가 아니다 — 다음
 * 세션이 팔을 하나 더 늘리면서 이 라벨을 무심코 흘리는 것을 막지 못한다.
 *
 * 라벨이 다른 팔의 컨텍스트로 새면 그 팔의 점수는 «기억이 통했다»가 아니라 «정답을 알려줬다»를
 * 재게 되고, 그 순간 이 축 전체가 무의미해진다.
 */
function injectOraclePreference(
  scenario: PreferenceRegressionScenario,
  condition: PreferenceRegressionCondition,
): string {
  if (condition !== "oracle") {
    throw new Error(
      `mori bench: impliedPreference(채점 정답 라벨)는 "oracle" 팔의 컨텍스트에만 주입된다 — ` +
        `조건 "${condition}"이 주입 경로에 들어왔다 (시나리오 "${scenario.id}"). ` +
        `다른 팔이 이 라벨을 보면 그 팔은 기억이 아니라 정답 공개를 재게 된다.`,
    );
  }
  return `${ORACLE_CARRY_OVER_PREFIX}${scenario.impliedPreference}`;
}

/**
 * 세션 사망을 건너 후속 세션에 이월되는 단 하나의 것. 팔이 다르다는 건 이 값이 다르다는
 * 뜻이고, 그 외에는 세 팔이 완전히 같은 코드를 탄다.
 *
 * `"memory-on"`만 `undefined`다 — 그 팔의 이월물은 러너가 손으로 넘기는 것이 아니라 mori
 * 커널이 스토어에서 직접 꺼내 오기 때문이다(`transformContext`).
 */
function buildFollowUpCarryOver(
  condition: PreferenceRegressionCondition,
  scenario: PreferenceRegressionScenario,
  compactionSummary: string | undefined,
): string | undefined {
  switch (condition) {
    case "memory-on":
      return undefined;
    case "memory-off":
      // 빈 요약도 «없음»으로 친다. 머리말만 얹고 넘어가면 후속 세션은 아무것도 못 본 채
      // 실행되는데 리포트에는 「압축 요약을 봤다」로 남아, 정확히 이 조각이 없앤 예전
      // «맥락을 아예 안 준» 베이스라인이 이름만 바꿔 되살아난다.
      if (compactionSummary === undefined || compactionSummary.trim() === "") {
        throw new Error(
          `mori bench: 시나리오 "${scenario.id}"의 "memory-off" 팔에 하네스 압축 요약이 없다 — ` +
            `이 팔은 맥락 세션을 돌고 그 압축 요약**만** 이월하는 베이스라인이다(#434).`,
        );
      }
      return `${COMPACTION_CARRY_OVER_PREFIX}${compactionSummary}`;
    case "oracle":
      return injectOraclePreference(scenario, condition);
    default: {
      // 팔을 하나 더 늘리면 여기서 **컴파일이 깨진다**. 이 `default`가 없으면 새 팔은 조용히
      // `undefined`(=이월물 없음)로 떨어져 «mori 팔인 척하는 빈 팔»이 된다 — 반환 타입에
      // `undefined`가 이미 있어서 타입 검사만으로는 안 잡힌다.
      const unhandled: never = condition;
      throw new Error(
        `mori bench: 알 수 없는 조건 "${String(unhandled)}" — 팔을 늘렸으면 그 팔이 세션 ` +
          `사망을 건너 무엇을 이월하는지도 여기서 정해야 한다.`,
      );
    }
  }
}

/**
 * mori 스토어를 한 번도 건드리지 않는 커널 — `"memory-off"`·`"oracle"` 팔의 맥락/후속 세션이
 * 모두 이것을 쓴다.
 *
 * 이 두 팔의 정직성은 «스토어를 안 읽는다»가 아니라 «스토어 핸들이 애초에 없다»로 보장된다:
 * `createKernel`(=`createMoriKernel`)을 부르지 않으므로 읽을 대상 자체가 존재하지 않는다.
 * `BufferKernel`(@mori/kernel)이 형태는 같지만 그쪽은 TEST-ONLY로 못박혀 있어(“Keep new
 * production wiring off it”) 벤치 배선이 쓸 것이 아니다.
 */
function createStoreFreeKernel(): MoriKernel {
  return {
    transformContext: (messages) => Promise.resolve(messages),
    observe: () => {},
    consolidate: () => Promise.resolve(),
    resetConversation: () => {},
    drain: () => Promise.resolve(),
  };
}

/** `runPreferenceRegressionMilestone`(milestone.ts, #407)도 재사용한다 — 반복해서 같은 리터럴을
 * 만들면 두 곳이 조용히 갈라질 수 있어서다. */
export const ZERO_USAGE = sumUsage([]);

export const RE_QUESTION_META_QUESTION =
  "이 응답이, 이전 대화에서 이미 행동으로 드러난 사용자의 습관·선호를 다시 명시적으로 " +
  '되묻는가 (예: "들여쓰기는 탭과 스페이스 중 어느 쪽으로 할까요?"처럼, 이미 알 수 있어야 ' +
  "할 것을 재질문하는 경우)?";

/** `\b` (word boundary) is ASCII-only in JS regex — "예, 맞다" never matches `/^예\b/` because
 * neither side of the boundary after "예" is a `\w` character. A negative lookahead for "another
 * letter follows" does the same "don't match part of a longer word" job without that gap. */
export function parseJudgeVerdict(text: string): boolean {
  return /^\s*(예|yes|y)(?![A-Za-z가-힣])/i.test(text.trim());
}

/** Provider 실패는 throw가 아니라 `stopReason: "error"`/`"aborted"`로 온다(session.ts:43-46,
 * cli/repl.ts의 매 턴 후 체크와 같은 컨벤션) — 확인 없이 넘어가면 실패 턴의 빈 `text`가
 * "메모리가 주입됐는데도 행동 적응에 실패했다"와 구분 안 되는 노이즈로 스코어러·axisRates에
 * 섞여 들어간다. */
function assertTurnOk(turn: MoriSessionTurn, scenarioId: string, where: string): void {
  if (turn.stopReason !== "stop") {
    throw new Error(
      `mori bench: 시나리오 "${scenarioId}"의 ${where} 턴이 실패했다 ` +
        `(stopReason: ${String(turn.stopReason)}) — 실패한 턴의 빈 출력이 점수·계기판에 섞이면 안 된다`,
    );
  }
}

/** 예/아니오 judge 프롬프트 조립 — 실시간 reader judge(`createReaderLlmJudge`)와 배치 judge
 * (`milestone.ts`의 `runPreferenceRegressionMilestone`)가 같은 문구를 쓴다. 프롬프트가 갈리면 두
 * 경로의 판정 성향이 달라져 milestone 리포트를 실시간 슬라이스(#405, #406)와 비교할 수 없게
 * 된다. */
export function buildJudgePrompt(question: string, followUpOutput: string): string {
  return (
    `${question}\n\n---\n판정 대상 출력:\n${followUpOutput}\n---\n\n` +
    '첫 단어를 "예" 또는 "아니오"로만 답하라.'
  );
}

/** `scorer.ts`의 `LlmJudge`를 #374의 `Reader` 위에 얹는 어댑터 — judge 모델 호출은 캐시·비용
 * 계측이 이미 배선된 reader를 그대로 타고, 이 파일은 예/아니오 프롬프트 조립만 맡는다. */
export function createReaderLlmJudge(reader: Reader): LlmJudge {
  return {
    async judge(question: string, followUpOutput: string): Promise<boolean> {
      const { text } = await reader.read(buildJudgePrompt(question, followUpOutput));
      return parseJudgeVerdict(text);
    },
  };
}

/**
 * `kernel.transformContext`를 감싸 후속 세션의 첫 호출이 실제로 뭔가를 주입했는지
 * (`결과 배열이 입력보다 길어졌는지`) 관측한다 — `SqliteMemoryKernel.transformContext`
 * (kernel/sqlite-memory-kernel.ts)가 주입할 것이 없으면 입력 배열을 그대로 돌려주는 계약에
 * 기댄 로컬 판정으로, 모델 호출 없이 `injection-hit-rate`의 실측치를 낸다.
 */
function withInjectionProbe(kernel: MoriKernel, onProbe: (injected: boolean) => void): MoriKernel {
  let observed = false;
  return {
    transformContext: async (messages, signal) => {
      const result = await kernel.transformContext(messages, signal);
      if (!observed) {
        observed = true;
        onProbe(result.length > messages.length);
      }
      return result;
    },
    observe: (event) => kernel.observe(event),
    consolidate: (llm, opts) => kernel.consolidate(llm, opts),
    resetConversation: () => kernel.resetConversation(),
    drain: () => kernel.drain(),
  };
}

/**
 * 후속 세션 컨텍스트 맨 앞에 이월물 한 건을 얹는다 — mori retrieval이 쓰는 것과 **같은**
 * `transformContext` 자리다. 세 팔이 이 한 자리에서만 갈리므로, 팔 사이 비교가 «주입물이
 * 다르다» 외의 변수를 타지 않는다.
 *
 * `withInjectionProbe` **바깥에** 감는다: `injected`(injection-hit-rate)는 mori retrieval이
 * 무엇을 꺼냈는지를 재는 축이라, 러너가 손으로 얹은 이월물이 그 수치에 섞이면 안 된다.
 */
function withCarryOver(kernel: MoriKernel, carryOver: string): MoriKernel {
  return {
    transformContext: async (messages, signal) => [
      { role: "user", content: carryOver, timestamp: 0 },
      ...(await kernel.transformContext(messages, signal)),
    ],
    observe: (event) => kernel.observe(event),
    consolidate: (llm, opts) => kernel.consolidate(llm, opts),
    resetConversation: () => kernel.resetConversation(),
    drain: () => kernel.drain(),
  };
}

/**
 * `"memory-on"` 전용 폴백 (#459, mori#343 후속 조각 1/2). retrieval이 후속 세션 첫 호출에서
 * 아무것도 못 주입했으면 — `kernel.transformContext`가 입력을 그대로 돌려주면 — `"memory-off"`
 * 팔과 **동일한** 하네스 압축 요약을 대신 얹는다. 이로써 ON ⊇ OFF가 배선상 보장된다: retrieval이
 * 뭔가 찾으면 그걸 쓰고, 못 찾으면 최소한 OFF가 보는 것과 같은 것을 본다 — #401 실측이 드러낸
 * "무주입 ON이 OFF보다 적게 받는다"는 비대칭이 없어진다.
 *
 * `withInjectionProbe` **바깥에** 감는다: `injected`(injection-hit-rate)는 mori retrieval의
 * 실측 적중만 세야 하고, 이 폴백이 채운 이월물은 그 수치에 섞이면 안 된다 — 폴백 회차를 적중으로
 * 계상하면 #401이 드러낸 33.3%라는 진단 신호가 지워진다(#459 완료 조건).
 */
function withOnArmFallback(
  kernel: MoriKernel,
  fallbackSummary: string,
  onFallback: (used: boolean) => void,
): MoriKernel {
  return {
    transformContext: async (messages, signal) => {
      const result = await kernel.transformContext(messages, signal);
      if (result.length > messages.length) {
        onFallback(false);
        return result;
      }
      onFallback(true);
      return [
        {
          role: "user",
          content: `${COMPACTION_CARRY_OVER_PREFIX}${fallbackSummary}`,
          timestamp: 0,
        },
        ...result,
      ];
    },
    observe: (event) => kernel.observe(event),
    consolidate: (llm, opts) => kernel.consolidate(llm, opts),
    resetConversation: () => kernel.resetConversation(),
    drain: () => kernel.drain(),
  };
}

/** `withOnArmFallback`이 쓸 압축 요약이 비어 있으면 던진다 — `buildFollowUpCarryOver`의
 * `"memory-off"` 가드와 같은 이유다: 머리말만 얹고 넘어가면 폴백이 "발동했지만 아무것도 못
 * 줬다"는 조용한 실패가 된다. */
function requireFallbackSummary(
  scenario: PreferenceRegressionScenario,
  compactionSummary: string | undefined,
): string {
  if (compactionSummary === undefined || compactionSummary.trim() === "") {
    throw new Error(
      `mori bench: 시나리오 "${scenario.id}"의 "memory-on" 팔 폴백에 쓸 하네스 압축 요약이 없다 — ` +
        `이 팔의 맥락 세션은 압축 요약을 만들어 둔 뒤에야 후속 세션의 무주입 폴백이 가능하다(#459).`,
    );
  }
  return compactionSummary;
}

export type CreateSessionFn = (
  env: NodeJS.ProcessEnv,
  deps: RunCliDeps,
) => Promise<CreateMoriSessionResult>;
export type CreateKernelFn = (
  root: string,
  sessionId: string,
  env: NodeJS.ProcessEnv,
) => MoriKernel;

function defaultCreateKernel(root: string, sessionId: string, env: NodeJS.ProcessEnv): MoriKernel {
  return createMoriKernel({ root, sessionId, env });
}

export interface ScenarioRunResult {
  scenarioId: string;
  scenarioTitle: string;
  condition: PreferenceRegressionCondition;
  followUpOutput: string;
  score: ScenarioScore;
  /** 후속 세션 첫 호출에서 **mori retrieval**이 실제로 뭔가를 주입했는가 — `"memory-off"`·
   * `"oracle"`에서는 항상 `false`다(두 팔은 mori 커널을 만들지 않는다. 그 팔들이 받는 이월물은
   * `withCarryOver`가 얹는 것이고 이 프로브는 그것을 세지 않는다). */
  injected: boolean;
  /** 후속 출력이 이미 확립된 습관을 재질문했는가 — mori 팔(`"memory-on"`) 밖에서는
   * `undefined`다. 이유는 `runPreferenceRegressionScenario`의 판정 분기 주석 참고. */
  reQuestioned: boolean | undefined;
  /** `EpisodeResult.compactionSummary` 그대로 — `"oracle"`이면 `undefined`. */
  compactionSummary: string | undefined;
  /** `EpisodeResult.fallbackUsed` 그대로 — `"memory-off"`·`"oracle"`이면 `undefined`. */
  fallbackUsed: boolean | undefined;
}

export interface RunEpisodeOptions {
  scenario: PreferenceRegressionScenario;
  condition: PreferenceRegressionCondition;
  /** 이 시나리오·조건 전용 격리 루트 — 다른 시나리오/조건과 스토어를 절대 공유하지 않는다. */
  root: string;
  env: NodeJS.ProcessEnv;
  streamFn: StreamFn;
  /** #372 캐시 스토어 — 주어지면 세션 턴(맥락 주입·후속 프롬프트)의 `streamFn`을 #372의
   * `withLlmCallCache`로 감싸 호출한다. `runPreferenceRegression`(위 `PreferenceRegressionOptions`)는
   * 이 필드를 넘기지 않는다 — 리더/재질문 판정만 캐시를 거치는 기존 배선을 바꾸지 않기 위해서다
   * (#423 비범위). 마일스톤 풀런(`milestone.ts`, #423)은 에피소드 자체가 재실행마다 전액
   * 재과금되는 것을 막기 위해 이 필드를 채운다. */
  cacheStore?: LlmCallCacheStore;
  /** #445 — absolute per-run scratch roots (this episode's `root` above, and
   * `PreferenceRegressionOptions.memorizeRoot`/`MilestoneBatchOptions.memorizeRoot` when the
   * caller has one) that a tool result's *content* can echo verbatim even though replaying the
   * same (model, prompt, params) call under a fresh root is still the same call — see
   * `llm-call-cache.ts`'s `normalizeVolatilePaths` for why. Only read when `cacheStore` is also
   * given; a `cacheStore`-less run never computes a cache key at all. */
  volatilePaths?: readonly string[];
  credentialStore?: CredentialStore;
  costLedger: CostLedger;
  createSession?: CreateSessionFn;
  createKernel?: CreateKernelFn;
}

export interface EpisodeResult {
  scenarioId: string;
  scenarioTitle: string;
  condition: PreferenceRegressionCondition;
  followUpOutput: string;
  /** 후속 세션 첫 호출에서 **mori retrieval**이 실제로 뭔가를 주입했는가 — `"memory-off"`·
   * `"oracle"`에서는 항상 `false`다 (`ScenarioRunResult.injected` 참고). */
  injected: boolean;
  /** 맥락 세션이 만든 하네스 압축 요약 원문 — `"memory-off"`에서는 그대로 후속 세션에
   * 이월되는 것이고, `"memory-on"`에서는 retrieval이 빈손일 때 폴백으로 쓰일 후보다(#459).
   * `"oracle"`에서는 항상 `undefined`다(맥락 세션을 압축할 이유가 없다). 리포트가 두 팔의
   * 이월물을 실물로 보여줄 수 있는 유일한 자리라 여기서 표면화한다(#401 완료 조건: 「OFF 팔의
   * 압축 요약 실물을 리포트에 남긴다」). */
  compactionSummary: string | undefined;
  /** `"memory-on"` 후속 세션이 retrieval 무주입 폴백을 실제로 썼는가(#459) — `"memory-off"`·
   * `"oracle"`에서는 항상 `undefined`다(그 팔들에는 폴백 개념 자체가 없다). 폴백 발동 여부가
   * 에피소드별로 리포트 JSON에 관측되도록 여기서 표면화한다(#459 완료 조건). */
  fallbackUsed: boolean | undefined;
}

/** 시나리오 하나 × 조건 하나를 채점 없이 끝까지 실행한다: 맥락 세션 주입 → 세션 사망 →
 * 후속 세션.
 *
 * **세 팔 모두 맥락 세션을 돈다** (#434). 팔이 갈리는 곳은 두 군데뿐이다:
 * (a) 커널 — `"memory-on"`만 진짜 mori 커널을 만든다. 나머지 둘은 `createStoreFreeKernel`이라
 *     스토어를 아예 열지 않는다.
 * (b) 이월물 — `buildFollowUpCarryOver`가 팔마다 하나씩 고른다.
 *
 * `"oracle"`의 맥락 세션은 후속 세션 결과에 아무 영향도 주지 않는다(후속 세션은 새 세션이고
 * 이월되는 것은 정답 라벨뿐이다). 그래도 돌린다 — 비용 축(`BENCH_AXES.cost`)이 팔 사이에
 * 비교 가능하려면 세 팔이 같은 수의 턴을 태워야 하고, 조각 4가 판정할 ORACLE−OFF 간격이
 * «주입물이 다르다» 이외의 변수를 타면 안 되기 때문이다.
 *
 * judge 호출(루브릭 판정·재질문 판정)은 이 함수의 범위 밖이다 — `runPreferenceRegressionScenario`가
 * 이 함수 위에 동기 채점을 바로 얹고(#387), `runPreferenceRegressionMilestone`(#407)은 여러
 * 에피소드의 followUpOutput을 먼저 모두 모은 뒤 판정 프롬프트를 한 번에 배치 제출한다 — 두
 * 호출자가 "세션을 끝까지 돌린다"는 이 로직을 공유하면서 채점 시점만 달리하기 위해 분리했다.
 */
export async function runPreferenceRegressionEpisode(
  options: RunEpisodeOptions,
): Promise<EpisodeResult> {
  const createSession = options.createSession ?? createMoriSession;
  const createKernel = options.createKernel ?? defaultCreateKernel;
  const streamFn = options.cacheStore
    ? withLlmCallCache(options.streamFn, options.cacheStore, undefined, options.volatilePaths)
    : options.streamFn;
  const baseDeps: RunCliDeps = {
    streamFn,
    root: options.root,
    ...(options.credentialStore ? { credentialStore: options.credentialStore } : {}),
  };

  // `"memory-on"`만 진짜 mori 커널을 만든다. 나머지 두 팔이 `createKernel`을 부르지 않는 것이
  // "이 팔들의 mori 스토어 읽기는 0건"의 근거다 — 스토어 핸들이 생기지 않는다.
  const usesMoriStore = options.condition === "memory-on";
  const contextKernel = usesMoriStore
    ? createKernel(options.root, "context", options.env)
    : createStoreFreeKernel();
  const contextResult = await createSession(options.env, { ...baseDeps, kernel: contextKernel });
  if (!contextResult.ok) {
    throw new Error(
      `mori bench: 시나리오 "${options.scenario.id}"의 맥락 세션 생성 실패 ` +
        `(exitCode ${String(contextResult.exitCode)})`,
    );
  }
  let compactionSummary: string | undefined;
  // try/finally: close()가 drain + session-end consolidation의 유일한 트리거이므로, 맥락
  // 턴 중 실패해도(assertTurnOk의 throw 포함) 이 세션의 관찰 기록이 응고되지 않은 채 남으면
  // 안 된다.
  try {
    for (const turn of options.scenario.contextTurns) {
      const result = await contextResult.session.prompt(turn);
      // record를 단언보다 먼저 둔다 — 실패한 턴도 토큰을 태웠다면 비용에는 잡혀야 정확하다.
      options.costLedger.record(BENCH_AXES.cost, result.usage);
      assertTurnOk(result, options.scenario.id, "맥락");
    }
    if (options.condition === "memory-off" || options.condition === "memory-on") {
      // OFF 팔은 이 요약을 그대로 이월하고, ON 팔은 아래에서 retrieval이 빈손일 때만 같은
      // 요약을 폴백으로 쓴다(#459) — 어느 쪽이든 세션이 죽기 전에, 그 세션 자신의 하네스
      // 압축으로 만들어 둬야 한다. 임계치를 기다리지 않고 직접 부르는 이유: 이 시나리오들의
      // 맥락 세션은 컨텍스트 창을 채울 만큼 길지 않아 자동 트리거(`compactIfContextFull`)가
      // 영영 안 걸린다. 압축 경로 자체는 pi의 기본 그대로다(#7과 별개 축 — 이 조각은 쓰기만
      // 한다).
      const compaction = await contextResult.session.compact();
      options.costLedger.record(BENCH_AXES.cost, compaction.usage);
      compactionSummary = compaction.summary;
    }
  } finally {
    // close()의 drain + session-end consolidation이 "세션 사망"이다 — 이 아래에서 여는 후속
    // 세션은 항상 이 시점 이후에 생성되므로, 스토어 전용 읽기만 보고 raw 세션 원문을
    // 재노출받지 않는다(memorize#176 leniency 함정).
    const contextClose = await contextResult.session.close();
    // #449: close()가 낸 세션종료 증류 LLM 호출 자체의 비용. `BENCH_AXES.cost`(맥락 턴 +
    // 압축)와 구분되는 축에 기록해야 「mori 팔의 증류가 얼마인가」를 원장에서 읽을 수 있다.
    options.costLedger.record(BENCH_AXES.sessionEndDistillation, contextClose.usage);
  }

  const carryOver = buildFollowUpCarryOver(options.condition, options.scenario, compactionSummary);

  let injected = false;
  const probedKernel = withInjectionProbe(
    usesMoriStore ? createKernel(options.root, "follow-up", options.env) : createStoreFreeKernel(),
    (hit) => {
      injected = hit;
    },
  );
  let fallbackUsed: boolean | undefined;
  let followUpKernel: MoriKernel;
  if (carryOver !== undefined) {
    followUpKernel = withCarryOver(probedKernel, carryOver);
  } else if (options.condition === "memory-on") {
    const fallbackSummary = requireFallbackSummary(options.scenario, compactionSummary);
    fallbackUsed = false;
    followUpKernel = withOnArmFallback(probedKernel, fallbackSummary, (used) => {
      fallbackUsed = used;
    });
  } else {
    followUpKernel = probedKernel;
  }
  const followUpResult = await createSession(options.env, { ...baseDeps, kernel: followUpKernel });
  if (!followUpResult.ok) {
    throw new Error(
      `mori bench: 시나리오 "${options.scenario.id}"의 후속 세션 생성 실패 ` +
        `(exitCode ${String(followUpResult.exitCode)})`,
    );
  }
  let turn!: MoriSessionTurn;
  try {
    turn = await followUpResult.session.prompt(options.scenario.followUpPrompt);
    options.costLedger.record(BENCH_AXES.cost, turn.usage);
    assertTurnOk(turn, options.scenario.id, "후속");
  } finally {
    const followUpClose = await followUpResult.session.close();
    options.costLedger.record(BENCH_AXES.sessionEndDistillation, followUpClose.usage);
  }

  // 로컬 판정(모델 호출 0건)이지만, 매 시나리오마다 기록해 둬야 `injection-hit-rate`가 리포트의
  // byAxis에 항상 나타난다 — 값이 0이어도 "측정했다"와 "측정 안 했다"는 다른 사실이다.
  options.costLedger.record(BENCH_AXES.injectionHitRate, ZERO_USAGE);

  // 재증류율(같은 응고가 기존 기억과 준중복을 만드는 비율)은 반복된 응고 이력이 있어야 판정
  // 가능하다 — 이 시나리오 프로토콜은 매번 빈 스토어에서 단발 응고 1회만 하므로 "비교할 이전
  // 기억이 없다"가 참인 값이다(가짜 추정이 아니다). `ExplicitConsolidateOutcome`
  // (cli/consolidation.ts)도 준중복 판정을 노출하지 않는다 — 실측 신호는 #388에서 반복 실행
  // 이력이 쌓인 뒤의 몫이다.
  options.costLedger.record(BENCH_AXES.reDistillationRate, ZERO_USAGE);

  return {
    scenarioId: options.scenario.id,
    scenarioTitle: options.scenario.title,
    condition: options.condition,
    followUpOutput: turn.text,
    injected,
    compactionSummary,
    fallbackUsed,
  };
}

export interface RunScenarioOnceOptions extends RunEpisodeOptions {
  /** 루브릭의 `llm-judge` 기준을 판정하는 judge (`scorer.ts`). */
  scoringJudge: LlmJudge;
  /** 계기판 전용 재질문 메타 질문을 판정하는 judge — 루브릭과 분리된 축(`BENCH_AXES.reQuestionRate`)
   * 아래 비용이 잡히도록 별도 reader 위에서 온다 (`runPreferenceRegression` 참고). */
  reQuestionJudge: LlmJudge;
}

/** 시나리오 하나 × 조건 하나를 끝까지 실행하고 곧바로(동기) 채점한다 —
 * `runPreferenceRegressionEpisode` 위에 스코어러 호출을 얹은 것. */
export async function runPreferenceRegressionScenario(
  options: RunScenarioOnceOptions,
): Promise<ScenarioRunResult> {
  const episode = await runPreferenceRegressionEpisode(options);

  const score = await scoreBehavioralAdaptation(
    options.scenario,
    episode.followUpOutput,
    options.scoringJudge,
  );

  let reQuestioned: boolean | undefined;
  if (options.condition === "memory-on") {
    reQuestioned = await options.reQuestionJudge.judge(
      RE_QUESTION_META_QUESTION,
      episode.followUpOutput,
    );
  } else {
    // 재질문율은 #327 계기판의 **mori 경로** 축이고, `computeAxisRates`의 분모도 mori 팔
    // 하나다 — `"memory-off"`·`"oracle"`에서 judge를 부르면 어떤 계기판도 읽지 않을 판정에
    // judge 토큰을 태우는 것이 된다. 축 자체는 그래도 채운다("측정 안 함"과 "0"은 다르다).
    options.costLedger.record(BENCH_AXES.reQuestionRate, ZERO_USAGE);
  }

  return {
    scenarioId: episode.scenarioId,
    scenarioTitle: episode.scenarioTitle,
    condition: episode.condition,
    followUpOutput: episode.followUpOutput,
    score,
    injected: episode.injected,
    reQuestioned,
    compactionSummary: episode.compactionSummary,
    fallbackUsed: episode.fallbackUsed,
  };
}

export interface PreferenceRegressionOptions {
  model: Model<Api>;
  streamFn: StreamFn;
  /** #372 캐시 스토어 디렉터리 — `createBenchRunner`가 한 번 스윕하고, 재질문 axis 전용
   * reader도 같은 디렉터리를 공유한다(캐시 키는 (모델,프롬프트,파라미터)라 axis가 달라도
   * 충돌하지 않는다). */
  cacheDir: string;
  /** 시나리오 × 조건마다 하위 디렉터리 하나씩 격리해 쓰는 스크래치 루트. 시나리오 id는
   * 경로에 고정으로 들어가므로(`root = workRoot/scenario.id/condition`), **호출마다 비어있는
   * 새 디렉터리**여야 한다 — 이전 실행의 잔여물이 남은 `workRoot`를 재사용하면 그 실행의
   * 맥락 세션이 응고한 기억이 이번 실행의 후속 세션에 그대로 주입돼 `injected`/점수가 "이번
   * 시나리오"가 아니라 "누적된 여러 번의 시나리오"를 반영하게 된다. */
  workRoot: string;
  /**
   * 스토어가 실제로 쓰이는 위치(`MEMORIZE_ROOT`, 기본 `~/.mori`)를 이 실행 동안만 격리 값으로
   * 바꾼다 — `path-resolver.ts`가 이 값을 스레드로 전달된 `env`가 아니라 `process.env`에서
   * 직접 읽기 때문에(session.test.ts의 같은 이유), 여기서 지정하지 않으면 벤치 시나리오
   * 스토어가 이 플릿이 실제로 쓰는 `~/.mori`에 섞여 들어간다. 절대 실제 프로젝트 체크아웃이나
   * 플릿의 `~/.mori`를 가리키지 않는다. `workRoot`와 같은 이유로 호출마다 새 디렉터리를 쓴다.
   */
  memorizeRoot: string;
  env?: NodeJS.ProcessEnv;
  credentialStore?: CredentialStore;
  scenarios?: readonly PreferenceRegressionScenario[];
  conditions?: readonly PreferenceRegressionCondition[];
  systemPrompt?: string;
  createSession?: CreateSessionFn;
  createKernel?: CreateKernelFn;
}

export interface PreferenceRegressionReport extends CostReport {
  scenarios: readonly ScenarioRunResult[];
  /** discussion #327의 계기판 3축 — 0~1 비율. `reDistillationRate`는 이 프로토콜(매 시나리오
   * 빈 스토어에서 단발 응고)에서는 항상 0이다(위 `runPreferenceRegressionScenario` 참고). */
  axisRates: {
    injectionHitRate: number;
    reDistillationRate: number;
    reQuestionRate: number;
  };
}

/**
 * `results`(여러 시나리오·조건 실행 결과)에서 discussion #327의 계기판 3축을 계산한다.
 * `runPreferenceRegression`가 단일 실행에 쓰고, #406의 나이틀리/주간 슬라이스가 여러 반복의
 * 결과를 합친 뒤 같은 계산을 재사용한다 — 비율 계산 로직이 두 곳에서 갈라지지 않게 하는 것이
 * 분리의 유일한 목적이다.
 *
 * 세 축 모두 분모가 **mori 팔(`"memory-on"`) 하나**다: injection-hit도 재질문도 mori
 * retrieval이 있어야 성립하는 값이고, `"memory-off"`(하네스 압축 요약)·`"oracle"`(정답 라벨)의
 * 후속 세션에는 mori 커널 자체가 없다. 팔 셋을 «mori 팔 vs 나머지»로 가르는 이 서술은
 * 「`"memory-off"`가 아닌 것」이 아니라 「`"memory-on"`인 것」으로 써야 한다 — 팔이 둘이던
 * 시절엔 두 표현이 같았지만 #434 이후로는 다르다.
 */
export function computeAxisRates(
  results: readonly ScenarioRunResult[],
): PreferenceRegressionReport["axisRates"] {
  const moriArmResults = results.filter((r) => r.condition === "memory-on");
  const rate = (hits: number, total: number): number => (total === 0 ? 0 : hits / total);

  return {
    injectionHitRate: rate(moriArmResults.filter((r) => r.injected).length, moriArmResults.length),
    reDistillationRate: 0,
    reQuestionRate: rate(
      moriArmResults.filter((r) => r.reQuestioned === true).length,
      moriArmResults.length,
    ),
  };
}

/**
 * `PREFERENCE_REGRESSION_SCENARIOS`(기본) 전체를 조건별로 실행하고 계기판 리포트를 낸다.
 * `#374`의 `createBenchRunner` 위에 얹는다 — 오케스트레이션 전체가 이 파일의 유일한 신규
 * 집계 지점이고, `writeCostReport`(cost-ledger.ts)를 그대로 재사용해 JSON으로 낼 수 있다
 * (반환값이 구조적으로 `CostReport`를 만족한다).
 *
 * **동시 호출 불가**: 실행 동안 `process.env.MEMORIZE_ROOT`를 프로세스 전역으로 바꿔 두고
 * `finally`에서 복원한다(`memorizeRoot` 옵션 참고) — 이 함수를 같은 프로세스에서 두 번
 * 동시에(예: `Promise.all`) 부르면 두 호출이 서로의 `MEMORIZE_ROOT`를 덮어써 스토어가
 * 섞인다. 한 프로세스당 한 번만, 순차로 부른다.
 */
export async function runPreferenceRegression(
  options: PreferenceRegressionOptions,
): Promise<PreferenceRegressionReport> {
  const env = options.env ?? process.env;
  const scenarios = options.scenarios ?? PREFERENCE_REGRESSION_SCENARIOS;
  const conditions = options.conditions ?? PREFERENCE_REGRESSION_CONDITIONS;

  const previousMemorizeRoot = process.env.MEMORIZE_ROOT;
  process.env.MEMORIZE_ROOT = options.memorizeRoot;
  try {
    const runner = await createBenchRunner(
      {
        cacheDir: options.cacheDir,
        model: options.model,
        streamFn: options.streamFn,
        ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
      },
      env,
    );

    // `injection-hit-rate`용 reader와 별도로, 재질문 메타 질문 전용 reader를 하나 더 둔다 —
    // `Reader`의 costAxis는 생성 시점에 고정되므로(reader.ts), 같은 reader로는 스코어러
    // 판정(비용은 `BENCH_AXES.cost`)과 계기판 재질문 판정(비용은 `BENCH_AXES.reQuestionRate`)을
    // 동시에 서로 다른 축에 걸 수 없다.
    const reQuestionReader = await createReader({
      path: "api",
      api: {
        model: options.model,
        streamFn: options.streamFn,
        cacheStore: new FileLlmCallCacheStore(options.cacheDir),
        costLedger: runner.costLedger,
        costAxis: BENCH_AXES.reQuestionRate,
        ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
      },
    });

    const scoringJudge = createReaderLlmJudge(runner.reader);
    const reQuestionJudge = createReaderLlmJudge(reQuestionReader);

    const results: ScenarioRunResult[] = [];
    for (const scenario of scenarios) {
      for (const condition of conditions) {
        const root = path.join(options.workRoot, scenario.id, condition);
        await fs.mkdir(root, { recursive: true });
        results.push(
          await runPreferenceRegressionScenario({
            scenario,
            condition,
            root,
            env,
            streamFn: options.streamFn,
            ...(options.credentialStore ? { credentialStore: options.credentialStore } : {}),
            costLedger: runner.costLedger,
            scoringJudge,
            reQuestionJudge,
            ...(options.createSession ? { createSession: options.createSession } : {}),
            ...(options.createKernel ? { createKernel: options.createKernel } : {}),
          }),
        );
      }
    }

    const report = runner.costLedger.report();

    return {
      ...report,
      scenarios: results,
      axisRates: computeAxisRates(results),
    };
  } finally {
    if (previousMemorizeRoot === undefined) delete process.env.MEMORIZE_ROOT;
    else process.env.MEMORIZE_ROOT = previousMemorizeRoot;
  }
}

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
import { IMPLICIT_MEM_BENCH_SCENARIOS, type ImplicitMemBenchScenario } from "./scenarios.js";
import { scoreBehavioralAdaptation, type LlmJudge, type ScenarioScore } from "./scorer.js";

/**
 * ImplicitMemBench 러너 배선 (#343 조각 2/4, #387). #386의 시나리오(scenarios.ts)·스코어러
 * (scorer.ts)를 #374의 `createBenchRunner` 위에 얹어 "맥락 세션 주입 → consolidation →
 * 세션 사망 → 후속 세션(스토어 전용 읽기) → 스코어러 호출" 흐름을 실행한다. 실제 모델 호출로
 * 진짜 수치를 내는 것은 #388의 몫 — 이 파일은 배선과 리포트 형태까지다.
 */

/** `"memory-off"`는 맥락 세션을 아예 건너뛰고 빈 스토어에서 곧장 `followUpPrompt`를 실행하는
 * 동일 모델 베이스라인 — 같은 흐름(러너 배선, 스코어러 호출)을 그대로 타되 주입할 것이 없다. */
export type ImplicitMemBenchCondition = "memory-on" | "memory-off";

/** `runImplicitMemBenchMilestone`(milestone.ts, #407)도 재사용한다 — 반복해서 같은 리터럴을
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
 * (`milestone.ts`의 `runImplicitMemBenchMilestone`)가 같은 문구를 쓴다. 프롬프트가 갈리면 두
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
  condition: ImplicitMemBenchCondition;
  followUpOutput: string;
  score: ScenarioScore;
  /** 후속 세션 첫 호출에서 `transformContext`가 실제로 뭔가를 주입했는가 — `"memory-off"`에서는
   * 항상 `false`다(맥락 세션 자체가 없어 주입할 스토어 내용도 없다). */
  injected: boolean;
  /** 후속 출력이 이미 확립된 습관을 재질문했는가 — `"memory-off"`에서는 재질문을 판정할 확립된
   * 맥락 자체가 없으므로 `undefined`. */
  reQuestioned: boolean | undefined;
}

export interface RunEpisodeOptions {
  scenario: ImplicitMemBenchScenario;
  condition: ImplicitMemBenchCondition;
  /** 이 시나리오·조건 전용 격리 루트 — 다른 시나리오/조건과 스토어를 절대 공유하지 않는다. */
  root: string;
  env: NodeJS.ProcessEnv;
  streamFn: StreamFn;
  /** #372 캐시 스토어 — 주어지면 세션 턴(맥락 주입·후속 프롬프트)의 `streamFn`을 #372의
   * `withLlmCallCache`로 감싸 호출한다. `runImplicitMemBench`(위 `ImplicitMemBenchOptions`)는
   * 이 필드를 넘기지 않는다 — 리더/재질문 판정만 캐시를 거치는 기존 배선을 바꾸지 않기 위해서다
   * (#423 비범위). 마일스톤 풀런(`milestone.ts`, #423)은 에피소드 자체가 재실행마다 전액
   * 재과금되는 것을 막기 위해 이 필드를 채운다. */
  cacheStore?: LlmCallCacheStore;
  credentialStore?: CredentialStore;
  costLedger: CostLedger;
  createSession?: CreateSessionFn;
  createKernel?: CreateKernelFn;
}

export interface EpisodeResult {
  scenarioId: string;
  scenarioTitle: string;
  condition: ImplicitMemBenchCondition;
  followUpOutput: string;
  /** 후속 세션 첫 호출에서 `transformContext`가 실제로 뭔가를 주입했는가 — `"memory-off"`에서는
   * 항상 `false`다(맥락 세션 자체가 없어 주입할 스토어 내용도 없다). */
  injected: boolean;
}

/** 시나리오 하나 × 조건 하나를 채점 없이 끝까지 실행한다: 맥락 세션 주입 → consolidation →
 * 세션 사망 → 후속 세션. `"memory-off"`는 맥락 단계를 건너뛴다.
 *
 * judge 호출(루브릭 판정·재질문 판정)은 이 함수의 범위 밖이다 — `runImplicitMemBenchScenario`가
 * 이 함수 위에 동기 채점을 바로 얹고(#387), `runImplicitMemBenchMilestone`(#407)은 여러
 * 에피소드의 followUpOutput을 먼저 모두 모은 뒤 판정 프롬프트를 한 번에 배치 제출한다 — 두
 * 호출자가 "세션을 끝까지 돌린다"는 이 로직을 공유하면서 채점 시점만 달리하기 위해 분리했다.
 */
export async function runImplicitMemBenchEpisode(
  options: RunEpisodeOptions,
): Promise<EpisodeResult> {
  const createSession = options.createSession ?? createMoriSession;
  const createKernel = options.createKernel ?? defaultCreateKernel;
  const streamFn = options.cacheStore
    ? withLlmCallCache(options.streamFn, options.cacheStore)
    : options.streamFn;
  const baseDeps: RunCliDeps = {
    streamFn,
    root: options.root,
    ...(options.credentialStore ? { credentialStore: options.credentialStore } : {}),
  };

  if (options.condition === "memory-on") {
    const contextKernel = createKernel(options.root, "context", options.env);
    const contextResult = await createSession(options.env, { ...baseDeps, kernel: contextKernel });
    if (!contextResult.ok) {
      throw new Error(
        `mori bench: 시나리오 "${options.scenario.id}"의 맥락 세션 생성 실패 ` +
          `(exitCode ${String(contextResult.exitCode)})`,
      );
    }
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
    } finally {
      // close()의 drain + session-end consolidation이 "세션 사망"이다 — 이 아래에서 여는 후속
      // 세션은 항상 이 시점 이후에 생성되므로, 스토어 전용 읽기만 보고 raw 세션 원문을
      // 재노출받지 않는다(memorize#176 leniency 함정).
      await contextResult.session.close();
    }
  }

  let injected = false;
  const followUpKernel = withInjectionProbe(
    createKernel(options.root, "follow-up", options.env),
    (hit) => {
      injected = hit;
    },
  );
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
    await followUpResult.session.close();
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
  };
}

export interface RunScenarioOnceOptions extends RunEpisodeOptions {
  /** 루브릭의 `llm-judge` 기준을 판정하는 judge (`scorer.ts`). */
  scoringJudge: LlmJudge;
  /** 계기판 전용 재질문 메타 질문을 판정하는 judge — 루브릭과 분리된 축(`BENCH_AXES.reQuestionRate`)
   * 아래 비용이 잡히도록 별도 reader 위에서 온다 (`runImplicitMemBench` 참고). */
  reQuestionJudge: LlmJudge;
}

/** 시나리오 하나 × 조건 하나를 끝까지 실행하고 곧바로(동기) 채점한다 —
 * `runImplicitMemBenchEpisode` 위에 스코어러 호출을 얹은 것. */
export async function runImplicitMemBenchScenario(
  options: RunScenarioOnceOptions,
): Promise<ScenarioRunResult> {
  const episode = await runImplicitMemBenchEpisode(options);

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
    // "memory-off"엔 재질문을 판정할 확립된 맥락이 없어 judge를 부르지 않는다 — 그래도 축은
    // 채운다.
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
  };
}

export interface ImplicitMemBenchOptions {
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
  scenarios?: readonly ImplicitMemBenchScenario[];
  conditions?: readonly ImplicitMemBenchCondition[];
  systemPrompt?: string;
  createSession?: CreateSessionFn;
  createKernel?: CreateKernelFn;
}

export interface ImplicitMemBenchReport extends CostReport {
  scenarios: readonly ScenarioRunResult[];
  /** discussion #327의 계기판 3축 — 0~1 비율. `reDistillationRate`는 이 프로토콜(매 시나리오
   * 빈 스토어에서 단발 응고)에서는 항상 0이다(위 `runImplicitMemBenchScenario` 참고). */
  axisRates: {
    injectionHitRate: number;
    reDistillationRate: number;
    reQuestionRate: number;
  };
}

/**
 * `results`(여러 시나리오·조건 실행 결과)에서 discussion #327의 계기판 3축을 계산한다.
 * `runImplicitMemBench`가 단일 실행에 쓰고, #406의 나이틀리/주간 슬라이스가 여러 반복의
 * 결과를 합친 뒤 같은 계산을 재사용한다 — 비율 계산 로직이 두 곳에서 갈라지지 않게 하는 것이
 * 분리의 유일한 목적이다.
 */
export function computeAxisRates(
  results: readonly ScenarioRunResult[],
): ImplicitMemBenchReport["axisRates"] {
  const onConditionResults = results.filter((r) => r.condition === "memory-on");
  const rate = (hits: number, total: number): number => (total === 0 ? 0 : hits / total);

  return {
    injectionHitRate: rate(
      onConditionResults.filter((r) => r.injected).length,
      onConditionResults.length,
    ),
    reDistillationRate: 0,
    reQuestionRate: rate(
      onConditionResults.filter((r) => r.reQuestioned === true).length,
      onConditionResults.length,
    ),
  };
}

/**
 * `IMPLICIT_MEM_BENCH_SCENARIOS`(기본) 전체를 조건별로 실행하고 계기판 리포트를 낸다.
 * `#374`의 `createBenchRunner` 위에 얹는다 — 오케스트레이션 전체가 이 파일의 유일한 신규
 * 집계 지점이고, `writeCostReport`(cost-ledger.ts)를 그대로 재사용해 JSON으로 낼 수 있다
 * (반환값이 구조적으로 `CostReport`를 만족한다).
 *
 * **동시 호출 불가**: 실행 동안 `process.env.MEMORIZE_ROOT`를 프로세스 전역으로 바꿔 두고
 * `finally`에서 복원한다(`memorizeRoot` 옵션 참고) — 이 함수를 같은 프로세스에서 두 번
 * 동시에(예: `Promise.all`) 부르면 두 호출이 서로의 `MEMORIZE_ROOT`를 덮어써 스토어가
 * 섞인다. 한 프로세스당 한 번만, 순차로 부른다.
 */
export async function runImplicitMemBench(
  options: ImplicitMemBenchOptions,
): Promise<ImplicitMemBenchReport> {
  const env = options.env ?? process.env;
  const scenarios = options.scenarios ?? IMPLICIT_MEM_BENCH_SCENARIOS;
  const conditions = options.conditions ?? (["memory-on", "memory-off"] as const);

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
          await runImplicitMemBenchScenario({
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

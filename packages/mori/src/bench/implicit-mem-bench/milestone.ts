import fs from "node:fs/promises";
import path from "node:path";
import type { Api, CredentialStore, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAnthropicBatchClient,
  type AnthropicBatchClient,
  type BatchJudgeRequest,
  type BatchJudgeResult,
} from "../batch/anthropic-batch-client.js";
import { BENCH_AXES, type BenchAxis } from "../axes.js";
import { createCostLedger, type CostLedger, type CostReport } from "../cost-ledger.js";
import { IMPLICIT_MEM_BENCH_SCENARIOS, type ImplicitMemBenchScenario } from "./scenarios.js";
import {
  buildJudgePrompt,
  computeAxisRates,
  parseJudgeVerdict,
  RE_QUESTION_META_QUESTION,
  runImplicitMemBenchEpisode,
  ZERO_USAGE,
  type CreateKernelFn,
  type CreateSessionFn,
  type EpisodeResult,
  type ImplicitMemBenchCondition,
  type ImplicitMemBenchReport,
  type ScenarioRunResult,
} from "./runner.js";
import { scoreBehavioralAdaptation, type LlmJudge } from "./scorer.js";

/**
 * 마일스톤 풀런 — #397의 3계층 케이든스 중 "Batch API 경유" 층 (#407, #397 조각 3/3). #387의
 * "맥락 세션 주입 → consolidation → 세션 사망 → 후속 세션" 에피소드 실행(`runImplicitMemBenchEpisode`)
 * 은 그대로 재사용하되, 채점(judge)만 2단계로 재구성한다:
 *
 * (a) 시나리오 × 조건의 모든 에피소드를 끝까지 실행해 `followUpOutput`을 모은다 — judge 호출은
 *     아직 하지 않는다.
 * (b) 모인 모든 판정 프롬프트(루브릭의 `llm-judge` 기준 + 계기판 재질문 메타 질문)를 하나의
 *     배치로 묶어 제출 → 폴링 → 완료되면 결과를 회수해 점수를 채운다.
 *
 * `runImplicitMemBench`(실시간 슬라이스, #405·#406)와 갈라지는 지점은 이 judge 호출 경로뿐이다
 * — 세션 턴(맥락 주입·후속 프롬프트) 자체는 순차 종속이라 배치화 대상이 아니다(각 턴이 이전
 * 턴의 모델 출력에 의존하므로 사전에 전체 요청을 알아야 하는 Batch API와 안 맞는다).
 */

function rubricCustomId(
  scenarioId: string,
  condition: ImplicitMemBenchCondition,
  criterionId: string,
): string {
  return `rubric::${scenarioId}::${condition}::${criterionId}`;
}

function reQuestionCustomId(scenarioId: string, condition: ImplicitMemBenchCondition): string {
  return `re-question::${scenarioId}::${condition}`;
}

/** `scoreBehavioralAdaptation`이 요구하는 `LlmJudge`를, 이미 회수된 배치 결과 위에서 리플레이한다.
 * `scenario.rubric`을 위에서 아래로 순차 평가하는 스코어러의 계약(scorer.ts)에 기대어, 이
 * judge가 호출될 때마다 미리 계산해 둔 `llm-judge` 기준 큐를 하나씩 소비한다 — 배치 결과를
 * 다시 스코어러 안으로 넣기 위해 `LlmJudge` 인터페이스를 깨지 않는 유일한 방법이다(#407 완료
 * 조건: "기존 LlmJudge 인터페이스를 깨지 않는 선에서 구현"). */
function createBatchReplayJudge(
  scenario: ImplicitMemBenchScenario,
  episode: EpisodeResult,
  resultsById: ReadonlyMap<string, BatchJudgeResult>,
  costLedger: CostLedger,
  costAxis: BenchAxis,
): LlmJudge {
  const queue = scenario.rubric
    .filter((criterion) => criterion.kind === "llm-judge")
    .map((criterion) => rubricCustomId(episode.scenarioId, episode.condition, criterion.id));
  let index = 0;

  return {
    judge(): Promise<boolean> {
      const customId = queue[index++];
      if (customId === undefined) {
        throw new Error(
          `mori bench: 시나리오 "${episode.scenarioId}"의 배치 judge 큐가 비었다 — 루브릭 반복 ` +
            `순서가 요청 수집 때와 어긋난다.`,
        );
      }
      const result = resultsById.get(customId);
      if (!result) {
        throw new Error(
          `mori bench: 시나리오 "${episode.scenarioId}"의 배치 결과 "${customId}"를 찾을 수 없다.`,
        );
      }
      if (result.error) {
        // 배치 항목 하나의 실패(만료·취소·오류)가 전체 마일스톤 풀런을 죽이지 않는다 — 빈 텍스트는
        // parseJudgeVerdict를 거치나 여기서는 스코어러가 boolean을 그대로 받으므로 명시적으로
        // false(불만족)로 떨어뜨린다. 정상 배치 결과와 구분해 리포트에서 추적할 수 있도록 결과
        // 자체(usage=0, error 필드)는 그대로 유지된다.
        costLedger.record(costAxis, result.usage);
        return Promise.resolve(false);
      }
      costLedger.record(costAxis, result.usage);
      return Promise.resolve(parseJudgeVerdict(result.text));
    },
  };
}

/** `ImplicitMemBenchReport`를 깨지 않고 확장한다 — `batchFailures`가 비어있지 않으면 이 리포트의
 * 점수는 신뢰할 수 없다(일부 judge 배치 항목이 만료·취소·오류로 죽어 "불만족"으로 채점됐다는
 * 뜻). 마일스톤 풀런은 게이트 판정에 쓰는 최고 신뢰도 측정이라, 이 정보 없이는 인프라 실패가
 * "모델이 못 했다"로 조용히 리포트에 섞여 들어간다 (#407 owner 수정요청). */
export interface MilestoneReport extends ImplicitMemBenchReport {
  batchFailures: readonly { customId: string; error: string }[];
  /** 이번 실행이 실제로 Batch API에 제출한 judge 요청 수 (`requests.length`). 0이면 시나리오가
   * 있어도 judge 채점이 배치를 한 번도 거치지 않았다는 뜻이다 — 루브릭에 `llm-judge` 기준이
   * 하나도 없거나 조건이 전부 `memory-off`일 때 발생한다(#416). 마일스톤 풀런의 존재 이유
   * (judge 채점이 Batch API를 경유한다는 것, #340 §3·#342 승인)를 이 값으로 검증할 수 있다. */
  judgeBatchRequests: number;
}

export interface MilestoneBatchOptions {
  /** 세션 턴(맥락·후속 프롬프트) 실행에 쓰는 모델 — mori 세션 자체의 실행 경로는 그대로 `"api"`
   * 다(#342 owner 승인). judge 배치에도 기본값으로 같은 모델이 쓰인다(`batchModel` 참고). */
  model: Model<Api>;
  streamFn: StreamFn;
  /** Batch API(judge 채점 패스) 인증용 Anthropic API 키. */
  batchApiKey: string;
  /** 배치 judge 호출에 쓸 모델 id. 기본값 `model.id`. */
  batchModel?: string;
  batchSystemPrompt?: string;
  /** 시나리오 × 조건마다 하위 디렉터리 하나씩 격리해 쓰는 스크래치 루트 — `runImplicitMemBench`
   * (runner.ts)의 `workRoot` 문서와 같은 이유로 호출마다 비어있는 새 디렉터리여야 한다. */
  workRoot: string;
  /** `MEMORIZE_ROOT`를 이 실행 동안만 격리 값으로 바꾼다 — `runImplicitMemBench`의 `memorizeRoot`
   * 문서와 같다. */
  memorizeRoot: string;
  env?: NodeJS.ProcessEnv;
  credentialStore?: CredentialStore;
  scenarios?: readonly ImplicitMemBenchScenario[];
  conditions?: readonly ImplicitMemBenchCondition[];
  createSession?: CreateSessionFn;
  createKernel?: CreateKernelFn;
  /** 테스트 시드: 실 `AnthropicBatchClient` 대신 이 구현을 쓴다. */
  batchClient?: AnthropicBatchClient;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

/**
 * `IMPLICIT_MEM_BENCH_SCENARIOS`(기본) 전체를 조건별로 실행하고, judge 채점만 Batch API를 거쳐
 * 계기판 리포트를 낸다. 완료 조건(#407)에 요구된 대로, 마일스톤 풀런 스크립트
 * (`milestone-cli.ts`)가 실시간 `streamFn`이 아니라 이 함수가 만드는 `AnthropicBatchClient`를
 * 통해서만 judge를 호출한다는 것을 이 파일이 코드로 보장한다.
 *
 * `runImplicitMemBench`와 마찬가지로 동시 호출 불가 — 실행 동안 `process.env.MEMORIZE_ROOT`를
 * 프로세스 전역으로 바꿔 두고 `finally`에서 복원한다.
 */
export async function runImplicitMemBenchMilestone(
  options: MilestoneBatchOptions,
): Promise<MilestoneReport> {
  const env = options.env ?? process.env;
  const scenarios = options.scenarios ?? IMPLICIT_MEM_BENCH_SCENARIOS;
  const conditions = options.conditions ?? (["memory-on", "memory-off"] as const);
  const costLedger = createCostLedger();

  const batchModel: Model<Api> =
    options.batchModel === undefined ? options.model : { ...options.model, id: options.batchModel };
  const batchClient =
    options.batchClient ??
    createAnthropicBatchClient({
      model: batchModel,
      apiKey: options.batchApiKey,
      ...(options.batchSystemPrompt === undefined
        ? {}
        : { systemPrompt: options.batchSystemPrompt }),
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });

  const previousMemorizeRoot = process.env.MEMORIZE_ROOT;
  process.env.MEMORIZE_ROOT = options.memorizeRoot;
  try {
    // Phase (a): run every episode to completion, deferring judging entirely.
    const episodes: EpisodeResult[] = [];
    for (const scenario of scenarios) {
      for (const condition of conditions) {
        const root = path.join(options.workRoot, scenario.id, condition);
        await fs.mkdir(root, { recursive: true });
        episodes.push(
          await runImplicitMemBenchEpisode({
            scenario,
            condition,
            root,
            env,
            streamFn: options.streamFn,
            ...(options.credentialStore ? { credentialStore: options.credentialStore } : {}),
            costLedger,
            ...(options.createSession ? { createSession: options.createSession } : {}),
            ...(options.createKernel ? { createKernel: options.createKernel } : {}),
          }),
        );
      }
    }

    // Phase (b): collect every judge prompt across every episode into one batch submission.
    const scenarioById = new Map(scenarios.map((s) => [s.id, s]));
    const requests: BatchJudgeRequest[] = [];
    for (const episode of episodes) {
      const scenario = scenarioById.get(episode.scenarioId);
      if (!scenario) {
        throw new Error(`mori bench: 시나리오 "${episode.scenarioId}"를 찾을 수 없다.`);
      }
      for (const criterion of scenario.rubric) {
        if (criterion.kind !== "llm-judge") continue;
        requests.push({
          customId: rubricCustomId(episode.scenarioId, episode.condition, criterion.id),
          prompt: buildJudgePrompt(criterion.question, episode.followUpOutput),
        });
      }
      if (episode.condition === "memory-on") {
        requests.push({
          customId: reQuestionCustomId(episode.scenarioId, episode.condition),
          prompt: buildJudgePrompt(RE_QUESTION_META_QUESTION, episode.followUpOutput),
        });
      }
    }

    const results = requests.length > 0 ? await batchClient.runBatch(requests) : [];
    const resultsById = new Map(results.map((r) => [r.customId, r]));

    // Fill in scores from the batch results.
    const scenarioResults: ScenarioRunResult[] = [];
    for (const episode of episodes) {
      // Presence guaranteed by the scenarioById lookup above (phase (a) built `episodes` from
      // exactly these scenarios).
      const scenario = scenarioById.get(episode.scenarioId);
      if (!scenario) {
        throw new Error(`mori bench: 시나리오 "${episode.scenarioId}"를 찾을 수 없다.`);
      }
      const scoringJudge = createBatchReplayJudge(
        scenario,
        episode,
        resultsById,
        costLedger,
        BENCH_AXES.cost,
      );
      const score = await scoreBehavioralAdaptation(scenario, episode.followUpOutput, scoringJudge);

      let reQuestioned: boolean | undefined;
      if (episode.condition === "memory-on") {
        const key = reQuestionCustomId(episode.scenarioId, episode.condition);
        const result = resultsById.get(key);
        if (!result) {
          throw new Error(
            `mori bench: 시나리오 "${episode.scenarioId}"의 재질문 배치 결과가 없다.`,
          );
        }
        costLedger.record(BENCH_AXES.reQuestionRate, result.usage);
        reQuestioned = result.error ? false : parseJudgeVerdict(result.text);
      } else {
        costLedger.record(BENCH_AXES.reQuestionRate, ZERO_USAGE);
      }

      scenarioResults.push({
        scenarioId: episode.scenarioId,
        scenarioTitle: episode.scenarioTitle,
        condition: episode.condition,
        followUpOutput: episode.followUpOutput,
        score,
        injected: episode.injected,
        reQuestioned,
      });
    }

    const batchFailures = results
      .filter((r) => r.error !== undefined)
      .map((r) => ({ customId: r.customId, error: r.error as string }));

    const report: CostReport = costLedger.report();
    return {
      ...report,
      scenarios: scenarioResults,
      axisRates: computeAxisRates(scenarioResults),
      batchFailures,
      judgeBatchRequests: requests.length,
    };
  } finally {
    if (previousMemorizeRoot === undefined) delete process.env.MEMORIZE_ROOT;
    else process.env.MEMORIZE_ROOT = previousMemorizeRoot;
  }
}

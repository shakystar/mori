import Anthropic from "@anthropic-ai/sdk";
import type {
  BatchCreateParams,
  MessageBatch,
  MessageBatchIndividualResponse,
} from "@anthropic-ai/sdk/resources/messages/batches";
import type {
  TextBlock,
  Usage as AnthropicUsage,
} from "@anthropic-ai/sdk/resources/messages/messages";
import {
  calculateCost,
  contentText,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type Usage,
} from "@earendil-works/pi-ai";
import { llmCallCacheKey, type LlmCallCacheStore } from "../cache/llm-call-cache.js";

/**
 * Anthropic Message Batches API 클라이언트 (#407, #397 조각 3/3). 이 리포에 Batch API를 쓰는
 * 코드가 이전에 없었다 — pi-ai(0.82.1)의 reader 실행 경로(`../reader.ts`)는 `"api"`(실시간
 * 스트리밍)와 `"claude-cli"` 두 가지뿐이라, 이 파일이 이 플릿 전체에서 처음 만들어지는 배치
 * 실행 경로다. `@anthropic-ai/sdk`를 직접 호출한다 — pi-ai는 배치를 지원하지 않는다.
 *
 * 세션 턴(맥락 주입·후속 프롬프트)은 이 클라이언트의 대상이 아니다: 각 턴이 이전 턴의 모델
 * 출력에 의존하는 순차 실행이라 사전에 전체 요청을 알아야 하는 Batch API와 근본적으로 안
 * 맞는다(runner.ts의 `runImplicitMemBenchEpisode` 참고). 이 클라이언트는 에피소드가 이미 끝난
 * 뒤 결과 텍스트를 판정하는 judge/reader 호출만 배치 대상으로 삼는다
 * (`implicit-mem-bench/milestone.ts`).
 */

/** 실 SDK가 요구하는 만큼만 뽑은 좁은 인터페이스 — `Batches`(SDK)는 `protected _client`를 가진
 * 클래스라 테스트 더블이 구조적으로 만족할 수 없다(nominal typing). 실 `client.messages.batches`
 * 인스턴스는 이 인터페이스를 구조적으로 만족하므로 그대로 대입할 수 있고, 테스트는 이 인터페이스
 * 모양의 평범한 객체를 주입한다. */
export interface AnthropicBatchesApi {
  create(body: BatchCreateParams): Promise<MessageBatch>;
  retrieve(batchId: string): Promise<MessageBatch>;
  results(batchId: string): Promise<AsyncIterable<MessageBatchIndividualResponse>>;
}

export interface BatchJudgeRequest {
  /** 결과를 요청과 다시 짝짓는 키 — Batch API 결과는 요청 순서를 보장하지 않는다(SDK 문서). */
  customId: string;
  prompt: string;
  systemPrompt?: string;
}

export interface BatchJudgeResult {
  customId: string;
  /** `"succeeded"`가 아니면 빈 문자열 — `parseJudgeVerdict`류 판정기에 그대로 흘려도 "아니오"로
   * 안전하게 떨어진다(빈 텍스트는 어떤 예/아니오 패턴에도 안 걸린다). */
  text: string;
  /** `"succeeded"`가 아닌 경우의 사유 (`"errored" | "canceled" | "expired"`). 성공 시 `undefined`. */
  error?: string;
  /** 성공한 요청의 실비용 사용량 — 배치 50% 할인이 반영된 값(`toPiUsage` 참고). 실패한 요청은
   * 과금되지 않으므로(Anthropic 문서) 0.  */
  usage: Usage;
}

export class BatchTimeoutError extends Error {
  readonly batchId: string;
  readonly elapsedMs: number;

  constructor(batchId: string, elapsedMs: number) {
    super(
      `mori bench: batch ${batchId} 폴링이 ${String(elapsedMs)}ms 후 타임아웃됐다 — 아직 진행 ` +
        `중이다. batch id를 기록해 두고 나중에 결과를 회수하거나, 타임아웃을 늘려 재시도해라.`,
    );
    this.name = "BatchTimeoutError";
    this.batchId = batchId;
    this.elapsedMs = elapsedMs;
  }
}

/** Anthropic 배치는 표준 요금의 정확히 50%로 과금된다(공식 문서) — pi-ai의 `calculateCost`가
 * 표준 요율로 계산한 값에 이 배수를 곱해 재사용한다. tiering/1h-cache-write 같은 요율 로직을
 * 절반 버전으로 새로 만들지 않기 위한 선택이다. */
const BATCH_COST_MULTIPLIER = 0.5;

const DEFAULT_MAX_TOKENS = 1024;
/** 30초 — Batch API는 완료까지 분~시간 단위가 걸릴 수 있어(공식 문서: 최대 24시간)
 * 초 단위보다 촘촘히 폴링해도 의미가 없다. */
const DEFAULT_POLL_INTERVAL_MS = 30_000;
/** 6시간 — Anthropic의 배치 만료 한도(24시간)보다 짧게 잡아, 만료를 기다리는 대신 이쪽에서
 * 먼저 포기하고 batch id를 보고한다(헤드리스 세션 하드 룰과 같은 이유: 무한 대기 금지). */
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Anthropic SDK의 `Usage`(입력/출력/캐시 토큰 수)를 pi-ai의 `Usage`(비용 포함)로 변환하고
 * 배치 할인(`BATCH_COST_MULTIPLIER`)을 적용한다. */
function toPiUsage(model: Model<Api>, sdkUsage: AnthropicUsage): Usage {
  const cacheRead = sdkUsage.cache_read_input_tokens ?? 0;
  const cacheWrite = sdkUsage.cache_creation_input_tokens ?? 0;
  const { input_tokens: input, output_tokens: output } = sdkUsage;

  const usage: Usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  usage.cost = {
    input: usage.cost.input * BATCH_COST_MULTIPLIER,
    output: usage.cost.output * BATCH_COST_MULTIPLIER,
    cacheRead: usage.cost.cacheRead * BATCH_COST_MULTIPLIER,
    cacheWrite: usage.cost.cacheWrite * BATCH_COST_MULTIPLIER,
    total: usage.cost.total * BATCH_COST_MULTIPLIER,
  };
  return usage;
}

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 배치 요청 하나를 `llmCallCacheKey`가 요구하는 `Context`로 편다 — reader.ts의 `createApiReader`가
 * 같은 이유로 쓰는 `timestamp: 0`을 그대로 따른다(실제 호출 시각이 키에 섞이면 재실행마다 캐시가
 * 미스한다). */
function batchRequestContext(
  request: BatchJudgeRequest,
  systemPrompt: string | undefined,
): Context {
  const effectiveSystemPrompt = request.systemPrompt ?? systemPrompt;
  return {
    ...(effectiveSystemPrompt === undefined ? {} : { systemPrompt: effectiveSystemPrompt }),
    messages: [{ role: "user", content: request.prompt, timestamp: 0 }],
  };
}

export interface AnthropicBatchClientConfig {
  /** 판정 호출에 쓸 모델 — `model.id`가 Batch API 요청의 `model` 필드가 되고, `model.cost`가
   * `toPiUsage`의 요율 계산에 쓰인다. */
  model: Model<Api>;
  maxTokens?: number;
  systemPrompt?: string;
  /** `batchesApi`를 주입하지 않을 때만 쓰인다 — 실 클라이언트 생성용 API 키. */
  apiKey?: string;
  /** 테스트 시드: 실 SDK 호출 대신 이 구현을 쓴다. 프로덕션에서는 `apiKey`로 만든 실 클라이언트가
   * 기본값이다. */
  batchesApi?: AnthropicBatchesApi;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** 테스트 시드: `setTimeout` 기반 sleep 대신 즉시 resolve하는 fake를 주입해 폴링 루프를
   * 실시간 대기 없이 검증한다. */
  sleep?: (ms: number) => Promise<void>;
  /** 테스트 시드: 경과 시간 측정을 `Date.now()` 대신 이 값으로 — 폴링 루프가 매 반복마다 부른다. */
  now?: () => number;
  /** #372/#423 캐시 스토어 — 주어지면 `runBatch`가 제출 전에 (model, prompt, systemPrompt) 키로
   * 조회해 히트한 요청은 배치에서 아예 빼고, 실 배치가 돌아온 성공 결과만 저장한다(실패
   * 결과는 저장하지 않는다 — 일시 실패가 영구 재생되는 것을 막는 `withLlmCallCache`와 같은
   * 정책). `submit`/`pollUntilComplete`/`retrieveResults`는 이 스토어를 모른다 — 캐시는
   * `runBatch`가 그 세 단계를 묶는 지점에서만 적용된다. */
  cacheStore?: LlmCallCacheStore;
}

export interface AnthropicBatchClient {
  /** 배치를 제출하고 batch id를 반환한다. */
  submit(requests: readonly BatchJudgeRequest[]): Promise<string>;
  /** `processing_status`가 `"ended"`가 될 때까지 폴링한다. `timeoutMs` 안에 끝나지 않으면
   * `BatchTimeoutError`를 던진다 — batch id는 그 에러에 실려 있으므로 호출자가 로그에 남기고
   * 비정상 종료할 수 있다. */
  pollUntilComplete(batchId: string): Promise<MessageBatch>;
  /** 완료된 배치의 결과를 회수한다. `pollUntilComplete`로 `"ended"`를 확인한 뒤에만 불러야
   * 한다(SDK의 `results()`는 그렇지 않으면 던진다). */
  retrieveResults(batchId: string): Promise<BatchJudgeResult[]>;
  /** submit → poll → retrieve를 순서대로 묶은 편의 메서드. */
  runBatch(requests: readonly BatchJudgeRequest[]): Promise<BatchJudgeResult[]>;
}

export function createAnthropicBatchClient(
  config: AnthropicBatchClientConfig,
): AnthropicBatchClient {
  const batchesApi: AnthropicBatchesApi =
    config.batchesApi ?? new Anthropic({ apiKey: config.apiKey }).messages.batches;
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = config.sleep ?? defaultSleep;
  const now = config.now ?? (() => Date.now());

  async function submit(requests: readonly BatchJudgeRequest[]): Promise<string> {
    if (requests.length === 0) {
      throw new Error("mori bench: 빈 요청 목록으로 배치를 제출할 수 없다.");
    }
    const batch = await batchesApi.create({
      requests: requests.map((request) => ({
        custom_id: request.customId,
        params: {
          model: config.model.id,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: request.prompt }],
          ...((request.systemPrompt ?? config.systemPrompt) === undefined
            ? {}
            : { system: request.systemPrompt ?? config.systemPrompt }),
        },
      })),
    });
    return batch.id;
  }

  async function pollUntilComplete(batchId: string): Promise<MessageBatch> {
    const start = now();
    for (;;) {
      const batch = await batchesApi.retrieve(batchId);
      if (batch.processing_status === "ended") return batch;
      const elapsed = now() - start;
      if (elapsed >= timeoutMs) throw new BatchTimeoutError(batchId, elapsed);
      await sleep(pollIntervalMs);
    }
  }

  async function retrieveResults(batchId: string): Promise<BatchJudgeResult[]> {
    const lines = await batchesApi.results(batchId);
    const results: BatchJudgeResult[] = [];
    for await (const line of lines) {
      if (line.result.type === "succeeded") {
        const message = line.result.message;
        const text = message.content
          .filter((block): block is TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("");
        results.push({
          customId: line.custom_id,
          text,
          usage: toPiUsage(config.model, message.usage),
        });
      } else {
        results.push({
          customId: line.custom_id,
          text: "",
          error: line.result.type,
          usage: ZERO_USAGE,
        });
      }
    }
    return results;
  }

  /** 캐시 히트 요청을 배치 제출 전에 걸러낸다 — 미스만 실제로 submit/poll/retrieve를 탄다.
   * `cacheStore`가 없으면(기존 호출자) 이전 그대로 무조건 전체 요청을 제출한다. */
  async function runBatchCached(
    store: LlmCallCacheStore,
    requests: readonly BatchJudgeRequest[],
  ): Promise<BatchJudgeResult[]> {
    const keyByCustomId = new Map(
      requests.map((request) => [
        request.customId,
        llmCallCacheKey(config.model, batchRequestContext(request, config.systemPrompt), {
          maxTokens,
        }),
      ]),
    );
    const cached: BatchJudgeResult[] = [];
    const misses: BatchJudgeRequest[] = [];
    for (const request of requests) {
      const key = keyByCustomId.get(request.customId);
      // Presence guaranteed by the map built from the same `requests` array above.
      if (key === undefined) continue;
      const hit = await store.get(key);
      if (hit) {
        cached.push({
          customId: request.customId,
          text: contentText(hit.content),
          usage: ZERO_USAGE,
        });
      } else {
        misses.push(request);
      }
    }
    if (misses.length === 0) return cached;

    const batchId = await submit(misses);
    await pollUntilComplete(batchId);
    const fresh = await retrieveResults(batchId);

    // 성공한 결과만 저장한다 — expired/canceled/errored를 캐시하면 일시 실패가 영구 재생된다
    // (`withLlmCallCache`와 같은 정책).
    await Promise.all(
      fresh
        .filter((result) => result.error === undefined)
        .map((result) => {
          const key = keyByCustomId.get(result.customId);
          if (key === undefined) return Promise.resolve();
          const message: AssistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: result.text }],
            api: config.model.api,
            provider: config.model.provider,
            model: config.model.id,
            usage: result.usage,
            stopReason: "stop",
            timestamp: 0,
          };
          return store.set(key, message);
        }),
    );

    return [...cached, ...fresh];
  }

  return {
    submit,
    pollUntilComplete,
    retrieveResults,
    async runBatch(requests: readonly BatchJudgeRequest[]): Promise<BatchJudgeResult[]> {
      if (config.cacheStore) return runBatchCached(config.cacheStore, requests);
      const batchId = await submit(requests);
      await pollUntilComplete(batchId);
      return retrieveResults(batchId);
    },
  };
}

import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { MoriKernel } from "../../agent/index.js";
import type { RunCliDeps } from "../../cli/types.js";
import type { CreateMoriSessionResult, MoriSessionTurn } from "../../session.js";
import type { AnthropicBatchClient, BatchJudgeRequest, BatchJudgeResult } from "../batch/anthropic-batch-client.js";
import { buildJudgePrompt, RE_QUESTION_META_QUESTION, type CreateKernelFn, type CreateSessionFn } from "./runner.js";
import type { ImplicitMemBenchScenario } from "./scenarios.js";
import { runImplicitMemBenchMilestone } from "./milestone.js";

function model(): Model<Api> {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
}

function usage(): Usage {
  return {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

const ZERO_USAGE_FIXTURE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fixtureScenario(id: string): ImplicitMemBenchScenario {
  return {
    id,
    title: `fixture-${id}`,
    contextTurns: ["ctx-1"],
    followUpPrompt: "follow-up prompt",
    impliedPreference: "some preference — never surfaced to a judge prompt",
    rubric: [
      {
        kind: "deterministic",
        id: "nonempty",
        description: "출력이 비어있지 않다",
        check: (output) => output.length > 0,
      },
      {
        kind: "llm-judge",
        id: "judge-criterion",
        description: "judge criterion",
        question: "이 출력이 기준을 만족하는가?",
      },
    ],
  };
}

function fakeKernel(options: { injects: boolean }): MoriKernel {
  return {
    transformContext: async (messages: AgentMessage[]) =>
      options.injects
        ? [{ role: "user", content: "[memory] fixture", timestamp: 0 }, ...messages]
        : messages,
    observe: () => {},
    consolidate: async () => {},
    resetConversation: () => {},
    drain: async () => {},
  };
}

/** Minimal session/kernel double — every follow-up injects, matching a "memory-on" run. */
function fakeHarness(): { createSession: CreateSessionFn; createKernel: CreateKernelFn } {
  const createKernel: CreateKernelFn = () => fakeKernel({ injects: true });
  const createSession: CreateSessionFn = (
    _env: NodeJS.ProcessEnv,
    deps: RunCliDeps,
  ): Promise<CreateMoriSessionResult> =>
    Promise.resolve({
      ok: true,
      session: {
        async prompt(text: string): Promise<MoriSessionTurn> {
          await deps.kernel?.transformContext([{ role: "user", content: text, timestamp: 0 }]);
          return { text: `reply:${text}`, stopReason: "stop", usage: usage() };
        },
        consolidate: () => Promise.resolve({ kind: "ok" as const }),
        close: () => Promise.resolve(),
      },
    });
  return { createSession, createKernel };
}

/** Fake `AnthropicBatchClient` that answers "예" to every request and records what it was
 * asked — lets a test assert the milestone runner drives judging through this seam instead of
 * a live `streamFn`. */
function fakeBatchClient(): AnthropicBatchClient & { requestsSeen: BatchJudgeRequest[][] } {
  const requestsSeen: BatchJudgeRequest[][] = [];
  const runBatch = (requests: readonly BatchJudgeRequest[]): Promise<BatchJudgeResult[]> => {
    requestsSeen.push([...requests]);
    return Promise.resolve(
      requests.map((r) => ({ customId: r.customId, text: "예, 그렇다.", usage: usage() })),
    );
  };
  return {
    submit: () => Promise.reject(new Error("submit should not be called directly by the runner")),
    pollUntilComplete: () =>
      Promise.reject(new Error("pollUntilComplete should not be called directly by the runner")),
    retrieveResults: () =>
      Promise.reject(new Error("retrieveResults should not be called directly by the runner")),
    runBatch,
    requestsSeen,
  };
}

describe("runImplicitMemBenchMilestone (#407, #397 조각 3/3)", () => {
  it("defers every judge call to the batch client instead of streamFn, and scores from batch results", async () => {
    const harness = fakeHarness();
    const batchClient = fakeBatchClient();
    const scenario = fixtureScenario("s1");
    const streamFn: StreamFn = async () => {
      throw new Error("streamFn must not be called for judging — that's the batch client's job");
    };

    const report = await runImplicitMemBenchMilestone({
      model: model(),
      streamFn,
      batchApiKey: "test-api-key",
      workRoot: "/tmp/mori-milestone-fixture-work",
      memorizeRoot: "/tmp/mori-milestone-fixture-store",
      scenarios: [scenario],
      conditions: ["memory-on"],
      batchClient,
      createSession: harness.createSession,
      createKernel: harness.createKernel,
    });

    // One batch submission for the whole run — rubric criterion + the re-question meta question.
    expect(batchClient.requestsSeen).toHaveLength(1);
    const requests = batchClient.requestsSeen[0] ?? [];
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.customId)).toEqual([
      "rubric::s1::memory-on::judge-criterion",
      "re-question::s1::memory-on",
    ]);
    expect(requests[0]?.prompt).toBe(
      buildJudgePrompt("이 출력이 기준을 만족하는가?", "reply:follow-up prompt"),
    );
    expect(requests[1]?.prompt).toBe(buildJudgePrompt(RE_QUESTION_META_QUESTION, "reply:follow-up prompt"));

    expect(report.scenarios).toHaveLength(1);
    const [result] = report.scenarios;
    expect(result?.score.score).toBe(1);
    expect(result?.reQuestioned).toBe(true);
    expect(report.axisRates.reQuestionRate).toBe(1);

    // MEMORIZE_ROOT is restored after the run, not left pointed at the bench scratch dir.
    expect(process.env.MEMORIZE_ROOT).toBeUndefined();
  });

  it("treats a non-succeeded batch result as an unsatisfied judge instead of throwing", async () => {
    const harness = fakeHarness();
    const failingBatchClient: AnthropicBatchClient = {
      submit: () => Promise.reject(new Error("unused")),
      pollUntilComplete: () => Promise.reject(new Error("unused")),
      retrieveResults: () => Promise.reject(new Error("unused")),
      runBatch: (requests) =>
        Promise.resolve(
          requests.map((r) => ({ customId: r.customId, text: "", error: "expired", usage: ZERO_USAGE_FIXTURE })),
        ),
    };

    const report = await runImplicitMemBenchMilestone({
      model: model(),
      streamFn: async () => {
        throw new Error("unused");
      },
      batchApiKey: "test-api-key",
      workRoot: "/tmp/mori-milestone-fixture-work-2",
      memorizeRoot: "/tmp/mori-milestone-fixture-store-2",
      scenarios: [fixtureScenario("s2")],
      conditions: ["memory-on"],
      batchClient: failingBatchClient,
      createSession: harness.createSession,
      createKernel: harness.createKernel,
    });

    const [result] = report.scenarios;
    // The deterministic criterion ("nonempty") still passes on the reply text — only the
    // llm-judge criterion is dragged down by the errored batch result, so the scenario's
    // aggregate score lands at 0.5 (1 of 2 rubric criteria satisfied), not 0.
    expect(result?.score.score).toBe(0.5);
    expect(result?.reQuestioned).toBe(false);
  });
});

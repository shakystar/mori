import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { contentText, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MoriKernel } from "../../agent/index.js";
import type { RunCliDeps } from "../../cli/types.js";
import type {
  CreateMoriSessionResult,
  MoriSessionClose,
  MoriSessionCompaction,
  MoriSessionTurn,
} from "../../session.js";
import { BENCH_AXES } from "../axes.js";
import { FileLlmCallCacheStore } from "../cache/file-cache-store.js";
import { createCostLedger } from "../cost-ledger.js";
import type { PreferenceRegressionScenario } from "./scenarios.js";
import {
  type CreateKernelFn,
  type CreateSessionFn,
  createReaderLlmJudge,
  PREFERENCE_REGRESSION_CONDITIONS,
  runPreferenceRegression,
  runPreferenceRegressionEpisode,
  runPreferenceRegressionScenario,
} from "./runner.js";

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
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
  };
}

/** Answers every prompt with a fixed judge verdict ("예" ⇒ every yes/no question passes) —
 * enough to exercise the reader/judge wiring without needing per-question branching. */
function fakeJudgeStreamFn(): StreamFn & { calls: number } {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "예, 그렇다." }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: usage(),
      stopReason: "stop",
      timestamp: 0,
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    return stream;
  };
  Object.defineProperty(fn, "calls", { get: () => calls });
  return fn as unknown as StreamFn & { calls: number };
}

function fixtureScenario(id: string): PreferenceRegressionScenario {
  return {
    id,
    title: `fixture-${id}`,
    contextTurns: ["ctx-1", "ctx-2"],
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

/** A `MoriKernel` double whose `transformContext` either grows the message array (simulating a
 * hit) or passes it through unchanged (a miss) — the exact contract `withInjectionProbe`
 * (runner.ts) reads. */
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

/** The summary `session.compact()` hands back in these fixtures — the OFF arm's whole
 * carry-over, so a test can assert it reached (or did not reach) the follow-up context. */
const FIXTURE_COMPACTION_SUMMARY = "fixture 하네스 압축 요약";

/** Builds a `CreateSessionFn`/`CreateKernelFn` pair driven entirely by test doubles — the real
 * `createMoriSession`/`createMoriKernel` need auth + a real on-disk store, which is out of scope
 * for a wiring-only test of this file's own orchestration. `session.prompt()` still calls the
 * injected `deps.kernel.transformContext` the same way `AgentHarness` would, so
 * `withInjectionProbe`'s wrapping is exercised end to end — and the messages that call returns
 * are recorded per session id (`contextFor`), which is how a test sees what an arm actually
 * carried into the follow-up session's context.
 *
 * `turnOverrides` lets a test make a given session id's `prompt()` return a specific turn (e.g. a
 * `stopReason: "error"` failure) instead of the default success reply — and close counts are
 * tracked per session id so a test can assert "context closed once, follow-up closed once"
 * independently. */
function fakeHarness(
  kernels: { context?: MoriKernel; "follow-up"?: MoriKernel },
  turnOverrides: Partial<Record<"context" | "follow-up", MoriSessionTurn>> = {},
): {
  createSession: CreateSessionFn;
  createKernel: CreateKernelFn;
  prompts: string[];
  closeCount: () => number;
  closeCountFor: (sessionId: "context" | "follow-up") => number;
  kernelCalls: { root: string; sessionId: string }[];
  compactCount: () => number;
  contextFor: (sessionId: "context" | "follow-up") => string;
} {
  const prompts: string[] = [];
  const kernelCalls: { root: string; sessionId: string }[] = [];
  const closesBySessionId: Record<string, number> = {};
  const contextBySessionId: Record<string, string[]> = {};
  let compacts = 0;
  let sessionsCreated = 0;

  const createKernel: CreateKernelFn = (root, sessionId) => {
    kernelCalls.push({ root, sessionId });
    const kernel = kernels[sessionId as "context" | "follow-up"];
    if (!kernel) throw new Error(`fakeHarness: no kernel double registered for "${sessionId}"`);
    return kernel;
  };

  const createSession: CreateSessionFn = (
    _env: NodeJS.ProcessEnv,
    deps: RunCliDeps,
  ): Promise<CreateMoriSessionResult> => {
    // Creation order, not `createKernel`'s last id: since #434 only the `"memory-on"` arm
    // builds mori kernels at all, so `createKernel` never fires for the other two — but every
    // arm creates exactly two sessions, context first, follow-up second. Modulo, not a
    // one-shot flag, because `runPreferenceRegression` drives many episodes through one
    // harness double.
    const sessionId = sessionsCreated++ % 2 === 0 ? "context" : "follow-up";
    return Promise.resolve({
      ok: true,
      session: {
        async prompt(text: string): Promise<MoriSessionTurn> {
          prompts.push(text);
          const messages: AgentMessage[] = [{ role: "user", content: text, timestamp: 0 }];
          const transformed = (await deps.kernel?.transformContext(messages)) ?? messages;
          // `AgentMessage` is a union whose custom variants have no `content` field — the
          // assertions here only ever ask "does this string appear anywhere in the context",
          // so serialize the whole list rather than narrowing per variant.
          (contextBySessionId[sessionId] ??= []).push(JSON.stringify(transformed));
          return (
            turnOverrides[sessionId] ?? {
              text: `reply:${text}`,
              stopReason: "stop",
              usage: usage(),
            }
          );
        },
        consolidate: () => Promise.resolve({ kind: "ok" as const }),
        compact(): Promise<MoriSessionCompaction> {
          compacts += 1;
          return Promise.resolve({ summary: FIXTURE_COMPACTION_SUMMARY, usage: usage() });
        },
        close(): Promise<MoriSessionClose> {
          closesBySessionId[sessionId] = (closesBySessionId[sessionId] ?? 0) + 1;
          return Promise.resolve({ usage: usage() });
        },
      },
    });
  };

  return {
    createSession,
    createKernel,
    prompts,
    closeCount: () => Object.values(closesBySessionId).reduce((sum, n) => sum + n, 0),
    closeCountFor: (sessionId) => closesBySessionId[sessionId] ?? 0,
    kernelCalls,
    compactCount: () => compacts,
    contextFor: (sessionId) => (contextBySessionId[sessionId] ?? []).join("\n"),
  };
}

describe("runPreferenceRegressionScenario (#387)", () => {
  it("memory-on: runs context turns before the follow-up, closes both sessions, and detects injection", async () => {
    const harness = fakeHarness({
      context: fakeKernel({ injects: false }),
      "follow-up": fakeKernel({ injects: true }),
    });
    const costLedger = createCostLedger();
    const scoringJudge = { judge: () => Promise.resolve(true) };
    const reQuestionJudge = { judge: () => Promise.resolve(true) };

    const result = await runPreferenceRegressionScenario({
      scenario: fixtureScenario("s1"),
      condition: "memory-on",
      root: "/tmp/fixture-root",
      env: {},
      streamFn: async () => {
        throw new Error("streamFn should not be called directly by the fake harness");
      },
      costLedger,
      scoringJudge,
      reQuestionJudge,
      createSession: harness.createSession,
      createKernel: harness.createKernel,
    });

    // Context turns ran, in order, before the follow-up prompt.
    expect(harness.prompts).toEqual(["ctx-1", "ctx-2", "follow-up prompt"]);
    expect(harness.kernelCalls.map((c) => c.sessionId)).toEqual(["context", "follow-up"]);
    // Both sessions were closed — the context session's close() is the "세션 사망" boundary.
    expect(harness.closeCount()).toBe(2);

    expect(result.injected).toBe(true);
    expect(result.reQuestioned).toBe(true);
    expect(result.followUpOutput).toBe("reply:follow-up prompt");
    expect(result.score.score).toBe(1);
    // Only the "memory-off" arm carries a compaction summary.
    expect(result.compactionSummary).toBeUndefined();

    // BENCH_AXES.cost recorded once per turn (2 context + 1 follow-up).
    const report = costLedger.report();
    expect(report.byAxis[BENCH_AXES.cost]?.totalTokens).toBe(15 * 3);
    // #449: close()'s own session-end distillation usage lands in a separate axis, once per
    // session closed (context + follow-up), not folded into BENCH_AXES.cost.
    expect(report.byAxis[BENCH_AXES.sessionEndDistillation]?.totalTokens).toBe(15 * 2);
    // The zero-cost local probes still populate their axes.
    expect(report.byAxis[BENCH_AXES.injectionHitRate]).toBeDefined();
    expect(report.byAxis[BENCH_AXES.reDistillationRate]).toBeDefined();
    expect(report.byAxis[BENCH_AXES.injectionHitRate]?.totalTokens).toBe(0);
  });

  it("memory-off: runs the context session and carries only the harness compaction summary — zero mori store reads", async () => {
    // 스토어를 읽으면 세는 커널 더블을 **두 세션 모두**에 등록해 둔다 — OFF 팔이 이 커널을
    // 한 번도 만들지 않는다는 것이 「스토어 읽기 0건」의 근거다. 팔이 다시 mori 커널을 타도록
    // 배선이 바뀌면 이 카운터가 0을 넘고 이 테스트가 깨진다 (#434, 이 축 전체의 전제).
    let storeReads = 0;
    const countingKernel: MoriKernel = {
      transformContext: (messages) => {
        storeReads += 1;
        return Promise.resolve(messages);
      },
      observe: () => {},
      consolidate: () => Promise.resolve(),
      resetConversation: () => {},
      drain: () => Promise.resolve(),
    };
    const harness = fakeHarness({ context: countingKernel, "follow-up": countingKernel });
    const costLedger = createCostLedger();
    let reQuestionCalls = 0;
    const reQuestionJudge = {
      judge: () => {
        reQuestionCalls += 1;
        return Promise.resolve(true);
      },
    };

    const result = await runPreferenceRegressionScenario({
      scenario: fixtureScenario("s2"),
      condition: "memory-off",
      root: "/tmp/fixture-root-off",
      env: {},
      streamFn: async () => {
        throw new Error("unused");
      },
      costLedger,
      scoringJudge: { judge: () => Promise.resolve(true) },
      reQuestionJudge,
      createSession: harness.createSession,
      createKernel: harness.createKernel,
    });

    // mori 스토어에 닿는 경로가 하나도 열리지 않았다: 커널을 만들지도, 읽지도 않았다.
    expect(harness.kernelCalls).toEqual([]);
    expect(storeReads).toBe(0);

    // 그런데도 맥락 세션은 돌았다 — 「맥락 세션을 건너뛰는」 예전 베이스라인이 아니다.
    expect(harness.prompts).toEqual(["ctx-1", "ctx-2", "follow-up prompt"]);
    expect(harness.closeCount()).toBe(2);

    // 세션 사망을 건너 남은 것은 하네스 압축 요약 하나뿐이고, 그것이 후속 컨텍스트에 있다.
    expect(harness.compactCount()).toBe(1);
    expect(harness.contextFor("follow-up")).toContain(FIXTURE_COMPACTION_SUMMARY);

    expect(result.injected).toBe(false);
    expect(result.reQuestioned).toBeUndefined();
    expect(reQuestionCalls).toBe(0);

    // The report surfaces the OFF arm's carry-over verbatim (#401 완료 조건).
    expect(result.compactionSummary).toBe(FIXTURE_COMPACTION_SUMMARY);

    // Still populated (zero-cost) even though the judge never ran.
    const report = costLedger.report();
    expect(report.byAxis[BENCH_AXES.reQuestionRate]).toBeDefined();
    expect(report.byAxis[BENCH_AXES.reQuestionRate]?.totalTokens).toBe(0);
  });

  it("oracle: injects impliedPreference into the follow-up context", async () => {
    const harness = fakeHarness({});
    const scenario = fixtureScenario("s-oracle");

    const result = await runPreferenceRegressionScenario({
      scenario,
      condition: "oracle",
      root: "/tmp/fixture-root-oracle",
      env: {},
      streamFn: async () => {
        throw new Error("unused");
      },
      costLedger: createCostLedger(),
      scoringJudge: { judge: () => Promise.resolve(true) },
      reQuestionJudge: {
        judge: () => Promise.reject(new Error("re-question judge must not run off the mori arm")),
      },
      createSession: harness.createSession,
      createKernel: harness.createKernel,
    });

    expect(harness.contextFor("follow-up")).toContain(scenario.impliedPreference);
    // 천장 팔도 mori 스토어는 안 쓴다 — 이월되는 것은 정답 라벨 하나다.
    expect(harness.kernelCalls).toEqual([]);
    expect(harness.compactCount()).toBe(0);
    expect(result.injected).toBe(false);
    expect(result.compactionSummary).toBeUndefined();
  });

  it("memory-on and memory-off never leak impliedPreference into the follow-up context", async () => {
    // 예외가 ORACLE 하나뿐임의 회귀 방지 — 라벨이 다른 팔에 새면 그 팔은 기억이 아니라 정답
    // 공개를 재게 된다 (scenarios.ts의 impliedPreference doc).
    for (const condition of ["memory-on", "memory-off"] as const) {
      const harness = fakeHarness({
        context: fakeKernel({ injects: false }),
        "follow-up": fakeKernel({ injects: true }),
      });
      const scenario = fixtureScenario(`s-leak-${condition}`);

      await runPreferenceRegressionScenario({
        scenario,
        condition,
        root: `/tmp/fixture-root-leak-${condition}`,
        env: {},
        streamFn: async () => {
          throw new Error("unused");
        },
        costLedger: createCostLedger(),
        scoringJudge: { judge: () => Promise.resolve(true) },
        reQuestionJudge: { judge: () => Promise.resolve(true) },
        createSession: harness.createSession,
        createKernel: harness.createKernel,
      });

      // 먼저 컨텍스트가 실제로 기록됐는지 확인한다 — 빈 문자열이면 아래 not.toContain이
      // 공허하게 통과해 false-green이 된다.
      expect(harness.contextFor("context")).toContain("ctx-1");
      expect(harness.contextFor("follow-up")).toContain("follow-up prompt");
      expect(harness.contextFor("context")).not.toContain(scenario.impliedPreference);
      expect(harness.contextFor("follow-up")).not.toContain(scenario.impliedPreference);
    }
  });

  it('a failed turn (stopReason !== "stop") rejects instead of scoring the empty output', async () => {
    const harness = fakeHarness(
      { context: fakeKernel({ injects: false }), "follow-up": fakeKernel({ injects: true }) },
      { "follow-up": { text: "", stopReason: "error", usage: usage() } },
    );
    const costLedger = createCostLedger();

    await expect(
      runPreferenceRegressionScenario({
        scenario: fixtureScenario("s3"),
        condition: "memory-on",
        root: "/tmp/fixture-root-fail",
        env: {},
        streamFn: async () => {
          throw new Error("unused");
        },
        costLedger,
        // If the failed turn's empty text ever reached these judges, they'd resolve and the
        // scenario would (wrongly) produce a score — fail loudly instead so a regression here
        // can't pass silently.
        scoringJudge: {
          judge: () => Promise.reject(new Error("scoringJudge must not run on a failed turn")),
        },
        reQuestionJudge: {
          judge: () => Promise.reject(new Error("reQuestionJudge must not run on a failed turn")),
        },
        createSession: harness.createSession,
        createKernel: harness.createKernel,
      }),
    ).rejects.toThrow(/후속 턴이 실패했다.*stopReason: error/);
  });

  it("closes both the context and follow-up sessions exactly once even when the follow-up turn fails", async () => {
    const harness = fakeHarness(
      { context: fakeKernel({ injects: false }), "follow-up": fakeKernel({ injects: true }) },
      { "follow-up": { text: "", stopReason: "error", usage: usage() } },
    );
    const costLedger = createCostLedger();

    await expect(
      runPreferenceRegressionScenario({
        scenario: fixtureScenario("s4"),
        condition: "memory-on",
        root: "/tmp/fixture-root-fail-close",
        env: {},
        streamFn: async () => {
          throw new Error("unused");
        },
        costLedger,
        scoringJudge: { judge: () => Promise.resolve(true) },
        reQuestionJudge: { judge: () => Promise.resolve(true) },
        createSession: harness.createSession,
        createKernel: harness.createKernel,
      }),
    ).rejects.toThrow();

    expect(harness.closeCountFor("context")).toBe(1);
    expect(harness.closeCountFor("follow-up")).toBe(1);
  });
});

describe("createReaderLlmJudge (#387)", () => {
  it("parses a leading 예/yes as satisfied and anything else as not", async () => {
    const judge = createReaderLlmJudge({
      read: (prompt: string) =>
        Promise.resolve({ text: prompt.includes("긍정") ? "예, 맞다." : "아니오." }),
    });

    await expect(judge.judge("q", "긍정 케이스")).resolves.toBe(true);
    await expect(judge.judge("q", "부정 케이스")).resolves.toBe(false);
  });
});

describe("runPreferenceRegression (#387)", () => {
  let cacheDir: string;
  let workRoot: string;
  let memorizeRoot: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "mori-preference-regression-cache-"));
    workRoot = await mkdtemp(join(tmpdir(), "mori-preference-regression-work-"));
    memorizeRoot = await mkdtemp(join(tmpdir(), "mori-preference-regression-store-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
    await rm(workRoot, { recursive: true, force: true });
    await rm(memorizeRoot, { recursive: true, force: true });
  });

  it("dry-runs all three conditions across scenarios with zero real API calls on replay and fills every axis", async () => {
    const scenarios = [fixtureScenario("a"), fixtureScenario("b")];
    const harness = fakeHarness({
      get context() {
        return fakeKernel({ injects: false });
      },
      get "follow-up"() {
        return fakeKernel({ injects: true });
      },
    });

    async function run(streamFn: StreamFn & { calls: number }) {
      return runPreferenceRegression({
        model: model(),
        streamFn,
        cacheDir,
        workRoot,
        memorizeRoot,
        scenarios,
        createSession: harness.createSession,
        createKernel: harness.createKernel,
      });
    }

    const firstStream = fakeJudgeStreamFn();
    const firstReport = await run(firstStream);
    expect(firstStream.calls).toBeGreaterThan(0);

    // Structural shape: one result per scenario × condition, every dashboard axis present.
    expect(firstReport.scenarios).toHaveLength(
      scenarios.length * PREFERENCE_REGRESSION_CONDITIONS.length,
    );
    expect(Object.keys(firstReport.axisRates).sort()).toEqual(
      ["injectionHitRate", "reDistillationRate", "reQuestionRate"].sort(),
    );
    for (const axis of Object.values(BENCH_AXES)) {
      expect(firstReport.byAxis[axis]).toBeDefined();
    }
    // memory-on scenarios injected (fixture kernel); the other two arms build no mori kernel
    // and are not in this axis's denominator at all.
    expect(firstReport.axisRates.injectionHitRate).toBe(1);
    expect(firstReport.axisRates.reDistillationRate).toBe(0);

    // MEMORIZE_ROOT is restored after the run, not left pointed at the bench scratch dir.
    expect(process.env.MEMORIZE_ROOT).toBeUndefined();

    // A second run against the same cache dir replays every judge call from cache.
    const secondStream = fakeJudgeStreamFn();
    await run(secondStream);
    expect(secondStream.calls).toBe(0);
  });
});

/** A `StreamFn` double that answers every call with a fixed reply and counts its own
 * invocations — lets a test observe whether an episode's session turns actually reach the
 * provider or replay from cache (mirrors milestone.test.ts's `fakeEpisodeStreamFn`, #423/#445). */
function fakeEpisodeStreamFn(): StreamFn & { calls: number } {
  let calls = 0;
  const fn: StreamFn = async (m) => {
    calls += 1;
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "episode reply" }],
      api: m.api,
      provider: m.provider,
      model: m.id,
      usage: usage(),
      stopReason: "stop",
      timestamp: 0,
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    return stream;
  };
  Object.defineProperty(fn, "calls", { get: () => calls });
  return fn as unknown as StreamFn & { calls: number };
}

/**
 * `CreateSessionFn` double whose `prompt()` actually calls `deps.streamFn` (unlike
 * `fakeHarness` above, whose `prompt()` never touches it) and folds `root` into the `Context`
 * as a `ToolResultMessage` shaped exactly like what `bash`'s `pwd` produces
 * (`tools/bash.ts`/`tools/bash-exec.ts`, and `agent/index.test.ts`'s "threads the injected root
 * to both the path guard and bash's cwd") — the mechanism #445's `volatilePaths` normalizes.
 * `compact()` is included for the `"memory-off"` condition's session-death carry-over.
 */
function toolRootEchoingHarness(
  m: Model<Api>,
  root: string,
): { createSession: CreateSessionFn; createKernel: CreateKernelFn } {
  const createKernel: CreateKernelFn = () => {
    throw new Error("fixture: createKernel should not be called for a store-free condition");
  };
  const createSession: CreateSessionFn = (
    _env: NodeJS.ProcessEnv,
    deps: RunCliDeps,
  ): Promise<CreateMoriSessionResult> =>
    Promise.resolve({
      ok: true,
      session: {
        async prompt(text: string): Promise<MoriSessionTurn> {
          await deps.kernel?.transformContext([{ role: "user", content: text, timestamp: 0 }]);
          if (!deps.streamFn) throw new Error("fixture: streamFn missing");
          const stream = await deps.streamFn(m, {
            messages: [
              { role: "user", content: text, timestamp: 0 },
              {
                role: "toolResult",
                toolCallId: "call-0",
                toolName: "bash",
                content: [{ type: "text", text: `${root}\n[exit code 0]` }],
                isError: false,
                timestamp: 0,
              },
            ],
          });
          const message = await stream.result();
          return {
            text: contentText(message.content),
            stopReason: message.stopReason,
            usage: message.usage,
          };
        },
        consolidate: () => Promise.resolve({ kind: "ok" as const }),
        compact: () => Promise.resolve({ summary: "unused fixture summary", usage: usage() }),
        close: () => Promise.resolve({ usage: usage() }),
      },
    });
  return { createSession, createKernel };
}

describe("runPreferenceRegressionEpisode cache + volatilePaths (#445)", () => {
  let cacheDir: string;
  let rootA: string;
  let rootB: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "mori-445-episode-cache-"));
    rootA = await mkdtemp(join(tmpdir(), "mori-445-episode-root-a-"));
    rootB = await mkdtemp(join(tmpdir(), "mori-445-episode-root-b-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  });

  it("hits cache across two runs under different scratch roots once each run declares its own root as a volatilePath", async () => {
    const m = model();
    const scenario = fixtureScenario("vol-hit");
    const cacheStore = new FileLlmCallCacheStore(cacheDir);

    async function run(root: string, episodeStreamFn: StreamFn & { calls: number }) {
      const harness = toolRootEchoingHarness(m, root);
      return runPreferenceRegressionEpisode({
        scenario,
        condition: "memory-off",
        root,
        env: {},
        streamFn: episodeStreamFn,
        cacheStore,
        volatilePaths: [root],
        costLedger: createCostLedger(),
        createSession: harness.createSession,
        createKernel: harness.createKernel,
      });
    }

    const firstStream = fakeEpisodeStreamFn();
    await run(rootA, firstStream);
    // Two context turns + one follow-up turn for this fixture scenario.
    expect(firstStream.calls).toBe(3);

    const secondStream = fakeEpisodeStreamFn();
    await run(rootB, secondStream);
    expect(secondStream.calls).toBe(0);
  });

  // Reverse-direction guard: the hit above comes from `volatilePaths` normalizing the roots
  // out, not from the two runs' contexts already coinciding for some other reason.
  it("misses cache across two runs under different scratch roots when volatilePaths is omitted", async () => {
    const m = model();
    const scenario = fixtureScenario("vol-miss");
    const cacheStore = new FileLlmCallCacheStore(cacheDir);

    async function run(root: string, episodeStreamFn: StreamFn & { calls: number }) {
      const harness = toolRootEchoingHarness(m, root);
      return runPreferenceRegressionEpisode({
        scenario,
        condition: "memory-off",
        root,
        env: {},
        streamFn: episodeStreamFn,
        cacheStore,
        costLedger: createCostLedger(),
        createSession: harness.createSession,
        createKernel: harness.createKernel,
      });
    }

    const firstStream = fakeEpisodeStreamFn();
    await run(rootA, firstStream);
    expect(firstStream.calls).toBe(3);

    const secondStream = fakeEpisodeStreamFn();
    await run(rootB, secondStream);
    expect(secondStream.calls).toBe(3);
  });
});

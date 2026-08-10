import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MoriKernel } from "../../agent/index.js";
import type { RunCliDeps } from "../../cli/types.js";
import type { CreateMoriSessionResult, MoriSessionTurn } from "../../session.js";
import { BENCH_AXES } from "../axes.js";
import { createCostLedger } from "../cost-ledger.js";
import type { PreferenceRegressionScenario } from "./scenarios.js";
import {
  type CreateKernelFn,
  type CreateSessionFn,
  createReaderLlmJudge,
  runPreferenceRegression,
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

/** Builds a `CreateSessionFn`/`CreateKernelFn` pair driven entirely by test doubles — the real
 * `createMoriSession`/`createMoriKernel` need auth + a real on-disk store, which is out of scope
 * for a wiring-only test of this file's own orchestration. `session.prompt()` still calls the
 * injected `deps.kernel.transformContext` the same way `AgentHarness` would, so
 * `withInjectionProbe`'s wrapping is exercised end to end.
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
} {
  const prompts: string[] = [];
  const kernelCalls: { root: string; sessionId: string }[] = [];
  const closesBySessionId: Record<string, number> = {};
  let lastSessionId: "context" | "follow-up" | undefined;

  const createKernel: CreateKernelFn = (root, sessionId) => {
    kernelCalls.push({ root, sessionId });
    lastSessionId = sessionId as "context" | "follow-up";
    const kernel = kernels[sessionId as "context" | "follow-up"];
    if (!kernel) throw new Error(`fakeHarness: no kernel double registered for "${sessionId}"`);
    return kernel;
  };

  const createSession: CreateSessionFn = (
    _env: NodeJS.ProcessEnv,
    deps: RunCliDeps,
  ): Promise<CreateMoriSessionResult> => {
    // `createKernel` for this session id always runs immediately before `createSession` in
    // `runPreferenceRegressionScenario`, so the last id it saw is this session's id.
    const sessionId = lastSessionId;
    if (!sessionId) throw new Error("fakeHarness: createSession called before createKernel");
    return Promise.resolve({
      ok: true,
      session: {
        async prompt(text: string): Promise<MoriSessionTurn> {
          prompts.push(text);
          await deps.kernel?.transformContext([{ role: "user", content: text, timestamp: 0 }]);
          return (
            turnOverrides[sessionId] ?? {
              text: `reply:${text}`,
              stopReason: "stop",
              usage: usage(),
            }
          );
        },
        consolidate: () => Promise.resolve({ kind: "ok" as const }),
        close(): Promise<void> {
          closesBySessionId[sessionId] = (closesBySessionId[sessionId] ?? 0) + 1;
          return Promise.resolve();
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

    // BENCH_AXES.cost recorded once per turn (2 context + 1 follow-up).
    const report = costLedger.report();
    expect(report.byAxis[BENCH_AXES.cost]?.totalTokens).toBe(15 * 3);
    // The zero-cost local probes still populate their axes.
    expect(report.byAxis[BENCH_AXES.injectionHitRate]).toBeDefined();
    expect(report.byAxis[BENCH_AXES.reDistillationRate]).toBeDefined();
    expect(report.byAxis[BENCH_AXES.injectionHitRate]?.totalTokens).toBe(0);
  });

  it("memory-off: skips the context phase entirely and never calls the re-question judge", async () => {
    const harness = fakeHarness({ "follow-up": fakeKernel({ injects: false }) });
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

    expect(harness.prompts).toEqual(["follow-up prompt"]);
    expect(harness.kernelCalls.map((c) => c.sessionId)).toEqual(["follow-up"]);
    // Only the follow-up session ran (and closed) — no context session at all.
    expect(harness.closeCount()).toBe(1);
    expect(result.injected).toBe(false);
    expect(result.reQuestioned).toBeUndefined();
    expect(reQuestionCalls).toBe(0);

    // Still populated (zero-cost) even though the judge never ran.
    const report = costLedger.report();
    expect(report.byAxis[BENCH_AXES.reQuestionRate]).toBeDefined();
    expect(report.byAxis[BENCH_AXES.reQuestionRate]?.totalTokens).toBe(0);
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

  it("dry-runs both conditions across scenarios with zero real API calls on replay and fills every axis", async () => {
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
    expect(firstReport.scenarios).toHaveLength(scenarios.length * 2);
    expect(Object.keys(firstReport.axisRates).sort()).toEqual(
      ["injectionHitRate", "reDistillationRate", "reQuestionRate"].sort(),
    );
    for (const axis of Object.values(BENCH_AXES)) {
      expect(firstReport.byAxis[axis]).toBeDefined();
    }
    // memory-on scenarios injected (fixture kernel), memory-off never does.
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

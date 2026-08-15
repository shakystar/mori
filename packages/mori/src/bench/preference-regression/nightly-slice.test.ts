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
import {
  DEFAULT_SLICE_REPEATS_PER_SCENARIO,
  resolveSliceRepeatsPerScenario,
  runNightlySlice,
} from "./nightly-slice.js";
import { PREFERENCE_REGRESSION_CONDITIONS } from "./runner.js";
import type { CreateKernelFn, CreateSessionFn } from "./runner.js";
import type { PreferenceRegressionScenario } from "./scenarios.js";

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

/** Answers every prompt with a fixed judge verdict — see runner.test.ts's identical fixture. */
function fakeJudgeStreamFn(): StreamFn {
  return async () => {
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

/** Fake session/kernel harness — always injects on the follow-up session, mirroring
 * runner.test.ts's fixture. `sessionRoots` records the scratch root of every session created
 * so a test can assert repeats land in distinct roots. It reads that off `deps.root` rather
 * than off `createKernel`: since #434 only the `"memory-on"` arm builds a mori kernel at all,
 * so `createKernel` no longer sees every (scenario, condition, repeat) combination. */
function fakeHarness(): {
  createSession: CreateSessionFn;
  createKernel: CreateKernelFn;
  sessionRoots: string[];
} {
  const sessionRoots: string[] = [];

  const createKernel: CreateKernelFn = (_root, sessionId) =>
    fakeKernel({ injects: sessionId === "follow-up" });

  const createSession: CreateSessionFn = (
    _env: NodeJS.ProcessEnv,
    deps: RunCliDeps,
  ): Promise<CreateMoriSessionResult> => {
    sessionRoots.push(deps.root ?? "");
    return Promise.resolve({
      ok: true,
      session: {
        async prompt(text: string): Promise<MoriSessionTurn> {
          await deps.kernel?.transformContext([{ role: "user", content: text, timestamp: 0 }]);
          return { text: `reply:${text}`, stopReason: "stop", usage: usage() };
        },
        consolidate: () => Promise.resolve({ kind: "ok" as const }),
        compact: () => Promise.resolve({ summary: "fixture compaction summary", usage: usage() }),
        close: () => Promise.resolve({ usage: usage() }),
      },
    });
  };

  return { createSession, createKernel, sessionRoots };
}

describe("resolveSliceRepeatsPerScenario (#406)", () => {
  it("defaults to memorize#176's per-type 10 when unset", () => {
    expect(resolveSliceRepeatsPerScenario({})).toBe(DEFAULT_SLICE_REPEATS_PER_SCENARIO);
    expect(DEFAULT_SLICE_REPEATS_PER_SCENARIO).toBe(10);
  });

  it("parses MORI_BENCH_SLICE_REPEATS", () => {
    expect(resolveSliceRepeatsPerScenario({ MORI_BENCH_SLICE_REPEATS: "3" })).toBe(3);
  });

  it("rejects a non-positive-integer value instead of silently falling back", () => {
    expect(() => resolveSliceRepeatsPerScenario({ MORI_BENCH_SLICE_REPEATS: "0" })).toThrow(
      /알 수 없는 슬라이스 반복 횟수/,
    );
    expect(() => resolveSliceRepeatsPerScenario({ MORI_BENCH_SLICE_REPEATS: "abc" })).toThrow(
      /알 수 없는 슬라이스 반복 횟수/,
    );
  });
});

describe("runNightlySlice (#406)", () => {
  let cacheDir: string;
  let workRoot: string;
  let memorizeRootBase: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "mori-nightly-slice-cache-"));
    workRoot = await mkdtemp(join(tmpdir(), "mori-nightly-slice-work-"));
    memorizeRootBase = await mkdtemp(join(tmpdir(), "mori-nightly-slice-store-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
    await rm(workRoot, { recursive: true, force: true });
    await rm(memorizeRootBase, { recursive: true, force: true });
  });

  it("repeats each scenario × condition combination in isolated roots and merges the report", async () => {
    const scenarios = [fixtureScenario("a"), fixtureScenario("b")];
    const harness = fakeHarness();

    const report = await runNightlySlice({
      model: model(),
      streamFn: fakeJudgeStreamFn(),
      cacheDir,
      workRoot,
      memorizeRootBase,
      scenarios,
      repeatsPerScenario: 2,
      createSession: harness.createSession,
      createKernel: harness.createKernel,
    });

    expect(report.repeatsPerScenario).toBe(2);
    // 2 scenarios × 3 conditions × 2 repeats.
    expect(report.scenarios).toHaveLength(
      scenarios.length * PREFERENCE_REGRESSION_CONDITIONS.length * 2,
    );

    // Every (scenario, condition, repeat) combination gets its own scratch root — context and
    // follow-up legitimately share one root within a combination (that's how injection works),
    // but no repeat reuses another repeat's root.
    expect(new Set(harness.sessionRoots).size).toBe(
      scenarios.length * PREFERENCE_REGRESSION_CONDITIONS.length * 2 /* repeats */,
    );

    // memory-on scenarios always inject (fixture kernel) — axisRates aggregate across every
    // repeat, not just the last one.
    expect(report.axisRates.injectionHitRate).toBe(1);

    // Cost is summed across every repeat's report, not just the last.
    for (const axis of Object.values(BENCH_AXES)) {
      expect(report.byAxis[axis]).toBeDefined();
    }
    expect(report.total.totalTokens).toBeGreaterThan(0);

    // MEMORIZE_ROOT is restored after every repeat.
    expect(process.env.MEMORIZE_ROOT).toBeUndefined();

    // Every "memory-off" result carries the harness compaction summary the fixture hands back —
    // the report is the only place that summary is ever exposed (#401).
    const offResults = report.scenarios.filter((r) => r.condition === "memory-off");
    expect(offResults.length).toBeGreaterThan(0);
    for (const result of offResults) {
      expect(result.compactionSummary).toBe("fixture compaction summary");
    }
    // #459: "memory-on" now also carries the harness compaction summary — the fallback
    // candidate for a follow-up whose retrieval comes up empty. Only "oracle" never carries one
    // (its context session is never compacted; see runner.ts's compaction branch).
    for (const result of report.scenarios.filter((r) => r.condition === "memory-on")) {
      expect(result.compactionSummary).toBe("fixture compaction summary");
    }
    for (const result of report.scenarios.filter((r) => r.condition === "oracle")) {
      expect(result.compactionSummary).toBeUndefined();
    }

    // The kill switch is computed on this report too, not just the milestone one (#401) — DeepSeek
    // runs can only go through nightly-slice (milestone-cli.ts is Anthropic-only).
    expect(report.killSwitch.threshold).toBeGreaterThan(0);
    expect(report.killSwitch.scenarios.length).toBeGreaterThan(0);
  });

  it("reruns against the same cacheDir for free — second call makes zero streamFn calls (#422)", async () => {
    const scenarios = [fixtureScenario("solo")];
    let callCount = 0;
    const countingStreamFn: StreamFn = (model, context, options) => {
      callCount++;
      return fakeJudgeStreamFn()(model, context, options);
    };

    const runOnce = async (): Promise<void> => {
      const runWorkRoot = await mkdtemp(join(tmpdir(), "mori-nightly-slice-work-"));
      const runMemorizeRootBase = await mkdtemp(join(tmpdir(), "mori-nightly-slice-store-"));
      const harness = fakeHarness();
      try {
        await runNightlySlice({
          model: model(),
          streamFn: countingStreamFn,
          cacheDir,
          workRoot: runWorkRoot,
          memorizeRootBase: runMemorizeRootBase,
          scenarios,
          repeatsPerScenario: 1,
          createSession: harness.createSession,
          createKernel: harness.createKernel,
        });
      } finally {
        await rm(runWorkRoot, { recursive: true, force: true });
        await rm(runMemorizeRootBase, { recursive: true, force: true });
      }
    };

    await runOnce();
    expect(callCount).toBeGreaterThan(0);

    callCount = 0;
    await runOnce();
    expect(callCount).toBe(0);
  });

  it("defaults repeatsPerScenario from MORI_BENCH_SLICE_REPEATS", async () => {
    const harness = fakeHarness();
    const report = await runNightlySlice({
      model: model(),
      streamFn: fakeJudgeStreamFn(),
      cacheDir,
      workRoot,
      memorizeRootBase,
      scenarios: [fixtureScenario("solo")],
      env: { MORI_BENCH_SLICE_REPEATS: "1" },
      createSession: harness.createSession,
      createKernel: harness.createKernel,
    });

    expect(report.repeatsPerScenario).toBe(1);
    // 1 scenario × 3 conditions × 1 repeat.
    expect(report.scenarios).toHaveLength(PREFERENCE_REGRESSION_CONDITIONS.length);
  });
});

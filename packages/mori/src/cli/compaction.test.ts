import {
  COMPACTION_SUMMARY_PREFIX,
  type AgentMessage,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  contentText,
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Usage,
} from "@earendil-works/pi-ai";
import type { ConsolidateCallOptions, ConsolidatorLlm } from "@mori/kernel";
import { describe, expect, it } from "vitest";
import { compactIfContextFull, subscribePostCompactConsolidation } from "./compaction.js";
import { fakeProviderModels } from "../agent/fake-provider-models.js";
import { createMoriAgent, type MoriAgent, type MoriKernel } from "../agent/index.js";

const ENV = { ANTHROPIC_API_KEY: "sk-ant-test" } as const;

/** The system prompt `createMoriAgent` gives the harness — what tells a turn request apart
 * from the compaction summarizer's own request, which carries pi's summarization prompt. */
const MORI_SYSTEM_PROMPT = "You are mori, a memory-native coding agent.";

/**
 * Enough characters that ONE message exceeds `DEFAULT_COMPACTION_SETTINGS.keepRecentTokens`
 * (20000) under pi's chars/4 heuristic. Below this, `findCutPoint` keeps the whole history as
 * "recent" and compaction has nothing to summarize — the context would not shrink and the
 * first test below would be measuring nothing.
 */
const LONG_REPLY_CHARS = 84_000;

function usage(totalTokens: number): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** A reported context size that clears any model's `contextWindow - reserveTokens`. */
const OVER_THRESHOLD = usage(10_000_000);
const UNDER_THRESHOLD = usage(100);

/** The decision fact planted in turn 1 — old enough by turn 4 that only the compaction
 * summary (not the retained tail) could still carry it. */
const PLANTED_DECISION = "결정: 세션 저장소를 SQLite에서 Postgres로 옮긴다";

/** The file-path fact planted in turn 3 — the turn whose reported usage crosses the
 * threshold, so it is the most recent content once compaction fires and lands in
 * `retainedTail`. */
const PLANTED_FILE_PATH = "packages/mori/src/session.ts";

interface ScriptedTurn {
  text: string;
  usage: Usage;
  /** Held open, keeps the harness in its non-idle `turn` phase until resolved. */
  gate?: Promise<void>;
}

interface Provider {
  streamFn: StreamFn;
  /** Every request the harness made, in order — turn requests and summarization alike. */
  requests: Context[];
  turnRequests: Context[];
}

/**
 * A provider double that plays one scripted reply per turn (reusing the last once the script
 * runs out) and answers the compaction summarizer with `summary`, told apart by the system
 * prompt rather than by call order — a compaction inserts a request in the middle of the
 * script otherwise.
 */
function scriptedProvider(turns: ScriptedTurn[], summary = "COMPACTED-SUMMARY"): Provider {
  const requests: Context[] = [];
  const turnRequests: Context[] = [];
  let turnCall = 0;

  const streamFn: StreamFn = async (model, context) => {
    requests.push(context);
    const summarizing = context.systemPrompt !== MORI_SYSTEM_PROMPT;

    let text = summary;
    let reported = usage(0);
    if (!summarizing) {
      turnRequests.push(context);
      const turn = turns[turnCall] ?? turns.at(-1)!;
      turnCall++;
      if (turn.gate) await turn.gate;
      text = turn.text;
      reported = turn.usage;
    }

    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: reported,
      stopReason: "stop",
      timestamp: 0,
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message } satisfies AssistantMessageEvent);
    stream.push({ type: "done", reason: "stop", message } satisfies AssistantMessageEvent);
    return stream;
  };

  return { streamFn, requests, turnRequests };
}

/** A `MoriKernel` that records what boundaries `consolidate` was called with. */
function spyKernel(onConsolidate: () => Promise<void> = async () => {}): MoriKernel & {
  boundaries: (string | undefined)[];
} {
  const boundaries: (string | undefined)[] = [];
  return {
    boundaries,
    transformContext: async (messages: AgentMessage[]) => messages,
    observe: () => {},
    drain: async () => {},
    resetConversation: () => {},
    consolidate: async (_llm: ConsolidatorLlm, opts?: ConsolidateCallOptions) => {
      boundaries.push(opts?.boundary);
      await onConsolidate();
    },
  };
}

function stubLlm(): ConsolidatorLlm {
  return { complete: async () => "[]" };
}

function agentOn(kernel: MoriKernel, streamFn: StreamFn): MoriAgent {
  const credentialStore = new InMemoryCredentialStore();
  return createMoriAgent(kernel, credentialStore, ENV, undefined, {
    tools: [],
    models: fakeProviderModels(ENV, credentialStore, streamFn),
  });
}

/** Flush every pending microtask — the post-compact boundary is fired without being awaited. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Every text block the provider was handed, concatenated — what "the context" means here. */
function textOf(context: Context): string {
  return context.messages
    .map((message) =>
      typeof message.content === "string" ? message.content : contentText(message.content),
    )
    .join("\n");
}

/**
 * Plants a decision fact (turn 1) and a file-path fact (turn 3), then re-asks for both on
 * turn 4 — same trigger technique as this describe block's
 * "shrinks the next turn's context to the summary plus the retained tail once compaction
 * fires" test, framed to match #7's completion criteria ("decision + file path recall across
 * a naturally-triggered compaction"). The cut point, message count, and the summary text this
 * scripted provider produces are recorded in docs/compaction-natural-trigger-baseline.md (#442).
 */
async function runRecallScenario() {
  const provider = scriptedProvider([
    { text: `${PLANTED_DECISION}\n${"x".repeat(LONG_REPLY_CHARS)} TURN-1`, usage: UNDER_THRESHOLD },
    { text: `${"x".repeat(LONG_REPLY_CHARS)} TURN-2`, usage: UNDER_THRESHOLD },
    {
      text: `${PLANTED_FILE_PATH}\n${"x".repeat(LONG_REPLY_CHARS)} TURN-3`,
      usage: OVER_THRESHOLD,
    },
    { text: "OK", usage: UNDER_THRESHOLD },
  ]);
  const agent = agentOn(spyKernel(), provider.streamFn);
  const errors: string[] = [];

  for (const prompt of ["one", "two", "three"]) {
    await agent.prompt(prompt);
    await compactIfContextFull(agent, (message) => errors.push(message));
  }
  await agent.prompt("그때 어떤 결정을 내렸고 어떤 파일을 다뤘는지 알려줘.");

  expect(errors).toEqual([]);
  return {
    beforeCompaction: provider.turnRequests[2]!,
    afterCompaction: provider.turnRequests[3]!,
  };
}

describe("compactIfContextFull", () => {
  it("shrinks the next turn's context to the summary plus the retained tail once compaction fires", async () => {
    // The only observable definition of "compaction is switched on": what the provider is
    // handed on the turn AFTER it fires. Three long turns build a history worth cutting; the
    // third reports a context size over the threshold, so the trigger fires exactly there.
    const reply = (n: number) => `${"x".repeat(LONG_REPLY_CHARS)} TURN-${n}`;
    const provider = scriptedProvider([
      { text: reply(1), usage: UNDER_THRESHOLD },
      { text: reply(2), usage: UNDER_THRESHOLD },
      { text: reply(3), usage: OVER_THRESHOLD },
      { text: reply(4), usage: UNDER_THRESHOLD },
    ]);
    const agent = agentOn(spyKernel(), provider.streamFn);
    const errors: string[] = [];

    for (const prompt of ["one", "two", "three", "four"]) {
      await agent.prompt(prompt);
      await compactIfContextFull(agent, (message) => errors.push(message));
    }

    expect(errors).toEqual([]);
    expect(provider.turnRequests).toHaveLength(4);
    const beforeCompaction = provider.turnRequests[2]!;
    const afterCompaction = provider.turnRequests[3]!;

    // The summary replaced the cut history, and the tail pi retained survived alongside it.
    expect(textOf(afterCompaction)).toContain(COMPACTION_SUMMARY_PREFIX);
    expect(textOf(afterCompaction)).toContain("COMPACTED-SUMMARY");
    expect(textOf(afterCompaction)).toContain("TURN-3");

    // …and the summarized history is gone from the context, which is the whole point.
    expect(textOf(beforeCompaction)).toContain("TURN-1");
    expect(textOf(afterCompaction)).not.toContain("TURN-1");
    expect(afterCompaction.messages.length).toBeLessThan(beforeCompaction.messages.length);
  });

  it("fires the post-compact consolidation boundary exactly once per compaction", async () => {
    // 0 catches a missing subscription, 2 catches the same boundary wired through both
    // `subscribe` and the `on("session_compact")` hook.
    const provider = scriptedProvider([
      { text: "x".repeat(LONG_REPLY_CHARS), usage: UNDER_THRESHOLD },
      { text: "x".repeat(LONG_REPLY_CHARS), usage: OVER_THRESHOLD },
      { text: "short", usage: UNDER_THRESHOLD },
    ]);
    const kernel = spyKernel();
    const agent = agentOn(kernel, provider.streamFn);
    const errors: string[] = [];
    subscribePostCompactConsolidation(agent, kernel, stubLlm, (message) => errors.push(message));

    for (const prompt of ["one", "two", "three"]) {
      await agent.prompt(prompt);
      await compactIfContextFull(agent, (message) => errors.push(message));
    }
    await settle();

    expect(kernel.boundaries).toEqual(["post-compact"]);
    expect(errors).toEqual([]);
  });

  it("swallows a busy compact() — no boundary fires and the turn still ends normally", async () => {
    // `compact()` requires `phase === "idle"`; a turn still running is the reachable way it
    // is not. The trigger must neither throw nor fire a boundary for a compaction that never
    // happened.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = scriptedProvider([
      { text: "first", usage: OVER_THRESHOLD },
      { text: "second", usage: UNDER_THRESHOLD, gate },
    ]);
    const kernel = spyKernel();
    const agent = agentOn(kernel, provider.streamFn);
    const errors: string[] = [];
    subscribePostCompactConsolidation(agent, kernel, stubLlm, (message) => errors.push(message));

    await agent.prompt("one");

    // A second turn, deliberately left in flight: the harness is in its `turn` phase from the
    // moment `prompt()` is called, and the gated provider keeps it there.
    const inFlight = agent.prompt("two");
    await compactIfContextFull(agent, (message) => errors.push(message));

    expect(kernel.boundaries).toEqual([]);
    expect(errors).toEqual([]);

    release();
    const last = await inFlight;
    await settle();

    expect(last.stopReason).toBe("stop");
    expect(kernel.boundaries).toEqual([]);
  });

  it("retains the recent file path across a naturally-triggered compaction", async () => {
    const { afterCompaction } = await runRecallScenario();

    // Confirms the trigger actually fired (not just "nothing changed, so nothing was lost").
    expect(textOf(afterCompaction)).toContain("COMPACTED-SUMMARY");
    expect(textOf(afterCompaction)).toContain(PLANTED_FILE_PATH);
  });

  it("loses the older decision once it falls past the retained tail", async () => {
    const { beforeCompaction, afterCompaction } = await runRecallScenario();

    // It was there before the boundary…
    expect(textOf(beforeCompaction)).toContain(PLANTED_DECISION);
    // …and isn't after: today's fixed-placeholder summarizer carries no content of its own,
    // so anything the deterministic retained-tail cut doesn't keep verbatim is gone. A real
    // summarizer's fidelity for this case is not what this scripted baseline measures.
    expect(textOf(afterCompaction)).not.toContain(PLANTED_DECISION);
  });
});

/**
 * The scenario docs/compaction-baseline-442.md reports on: a `compactIfContextFull` (this
 * directory's `compaction.ts`, #409) NATURAL trigger, as opposed to the preference-regression
 * bench's `memory-off` arm which forces it directly via the `Session` method (#434) — a benchmark
 * context never grows large enough to cross pi's real threshold, so nothing in this repo had
 * ever exercised the trigger end-to-end before (#7 재점검,
 * https://github.com/shakystar/mori/issues/7#issuecomment-5240373000). #442 fills that gap.
 *
 * A decision fact and a file-path fact are planted in the early history and never re-stated.
 * Whether each survives past the compaction boundary is judged mechanically — plain string
 * containment on the context the harness would send the NEXT turn (no judge model, per the
 * issue's non-goals) — which is the same technique `compaction.test.ts`'s first test already
 * uses to check what a compaction did to the context.
 *
 * This file never forces compaction directly — it only drives turns and lets
 * `compactIfContextFull` decide, the same way `cli/repl.ts` and `session.ts` do in production.
 */
import { type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  contentText,
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Usage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { compactIfContextFull } from "./compaction.js";
import { fakeProviderModels } from "../agent/fake-provider-models.js";
import { createMoriAgent, type MoriAgent } from "../agent/index.js";

const ENV = { ANTHROPIC_API_KEY: "sk-ant-test" } as const;

/** Same marker `compaction.test.ts` uses to tell a turn request from the compaction
 * summarizer's own request. */
const MORI_SYSTEM_PROMPT = "You are mori, a memory-native coding agent.";

/** Same sizing `compaction.test.ts` documents: big enough that one message alone exceeds
 * `DEFAULT_COMPACTION_SETTINGS.keepRecentTokens` (20000) under pi's chars/4 heuristic, so
 * `findCutPoint` actually has old history to cut instead of keeping everything as "recent". */
const LONG_REPLY_CHARS = 84_000;

/** The decision fact planted in turn 1 — old enough by turn 4 that only the compaction
 * summary (not the retained tail) could still carry it. */
const PLANTED_DECISION = "결정: 세션 저장소를 SQLite에서 Postgres로 옮긴다";

/** The file-path fact planted in turn 3 — the turn whose reported usage crosses the
 * threshold, so it is the most recent content once compaction fires and lands in
 * `retainedTail`. */
const PLANTED_FILE_PATH = "packages/mori/src/session.ts";

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

interface ScriptedTurn {
  text: string;
  usage: Usage;
}

interface Provider {
  streamFn: StreamFn;
  turnRequests: Context[];
}

/** Same provider double as `compaction.test.ts`: one scripted reply per turn, and a fixed
 * summary for the compaction summarizer, told apart by system prompt. */
function scriptedProvider(turns: ScriptedTurn[], summary = "COMPACTED-SUMMARY"): Provider {
  const turnRequests: Context[] = [];
  let turnCall = 0;

  const streamFn: StreamFn = async (model, context) => {
    const summarizing = context.systemPrompt !== MORI_SYSTEM_PROMPT;

    let text = summary;
    let reported = usage(0);
    if (!summarizing) {
      turnRequests.push(context);
      const turn = turns[turnCall] ?? turns.at(-1)!;
      turnCall++;
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

  return { streamFn, turnRequests };
}

function agentOn(streamFn: StreamFn): MoriAgent {
  const credentialStore = new InMemoryCredentialStore();
  return createMoriAgent(
    {
      transformContext: async (messages: AgentMessage[]) => messages,
      observe: () => {},
      drain: async () => {},
      resetConversation: () => {},
      consolidate: async () => {},
    },
    credentialStore,
    ENV,
    undefined,
    { tools: [], models: fakeProviderModels(ENV, credentialStore, streamFn) },
  );
}

function textOf(context: Context): string {
  return context.messages
    .map((message) =>
      typeof message.content === "string" ? message.content : contentText(message.content),
    )
    .join("\n");
}

/**
 * Plants the decision (turn 1) and the file path (turn 3), then drives the trigger through
 * turn 4 by prompting alone and letting `compactIfContextFull` (the same function
 * `cli/repl.ts` and `session.ts` call between turns in production) decide.
 */
async function runScenario() {
  const provider = scriptedProvider([
    { text: `${PLANTED_DECISION}\n${"x".repeat(LONG_REPLY_CHARS)} TURN-1`, usage: UNDER_THRESHOLD },
    { text: `${"x".repeat(LONG_REPLY_CHARS)} TURN-2`, usage: UNDER_THRESHOLD },
    {
      text: `${PLANTED_FILE_PATH}\n${"x".repeat(LONG_REPLY_CHARS)} TURN-3`,
      usage: OVER_THRESHOLD,
    },
    { text: "OK", usage: UNDER_THRESHOLD },
  ]);
  const agent = agentOn(provider.streamFn);
  const errors: string[] = [];

  for (const prompt of ["one", "two", "three"]) {
    await agent.prompt(prompt);
    await compactIfContextFull(agent, (message) => errors.push(message));
  }
  // Turn 4 re-asks for both planted facts — the built context is the mechanical stand-in for
  // "does the agent still have this to answer from" (no judge model, per the issue's scope).
  await agent.prompt("그때 어떤 결정을 내렸고 어떤 파일을 다뤘는지 알려줘.");

  expect(errors).toEqual([]);
  return {
    beforeCompaction: provider.turnRequests[2]!,
    afterCompaction: provider.turnRequests[3]!,
  };
}

describe("compaction baseline (#442)", () => {
  it("retains the recent file path across a naturally-triggered compaction", async () => {
    const { afterCompaction } = await runScenario();

    // Confirms the trigger actually fired (not just "nothing changed, so nothing was lost").
    expect(textOf(afterCompaction)).toContain("COMPACTED-SUMMARY");
    expect(textOf(afterCompaction)).toContain(PLANTED_FILE_PATH);
  });

  it("loses the older decision once it falls past the retained tail", async () => {
    const { beforeCompaction, afterCompaction } = await runScenario();

    // It was there before the boundary…
    expect(textOf(beforeCompaction)).toContain(PLANTED_DECISION);
    // …and isn't after: today's fixed-placeholder summarizer carries no content of its own,
    // so anything the deterministic retained-tail cut doesn't keep verbatim is gone. A real
    // summarizer's fidelity for this case is not what this scripted baseline measures.
    expect(textOf(afterCompaction)).not.toContain(PLANTED_DECISION);
  });
});

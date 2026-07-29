import type {
  Agent,
  AgentEvent,
  AgentMessage,
  Context,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { BufferKernel } from "@mori/kernel";
import { describe, expect, it } from "vitest";
import { createMoriAgent } from "../agent.js";
import type { ReplInputSource, ReplLine } from "./repl-input.js";
import { runRepl } from "./repl.js";

const ENV = { ANTHROPIC_API_KEY: "sk-ant-test" } as const;

/**
 * A real agent on the production wiring (kernel, model resolution, event plumbing), with
 * only the provider stream faked. Tools are dropped — this file is about the input/output
 * loop, and `createMoriTools` would otherwise pin a working root onto every test.
 */
function testAgent(streamFn: StreamFn): Agent {
  const kernel = new BufferKernel<AgentMessage, AgentEvent>();
  return createMoriAgent(kernel, new InMemoryCredentialStore(), ENV, streamFn, { tools: [] });
}

/** A completed assistant response consisting of `text`, streamed one delta at a time. */
function textStream(model: Model<never>, text: string) {
  const stream = createAssistantMessageEventStream();
  const base: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };

  stream.push({ type: "start", partial: base } satisfies AssistantMessageEvent);
  stream.push({
    type: "text_delta",
    contentIndex: 0,
    delta: text,
    partial: { ...base, content: [{ type: "text", text }] },
  } satisfies AssistantMessageEvent);
  const final: AssistantMessage = { ...base, content: [{ type: "text", text }] };
  stream.push({ type: "done", reason: "stop", message: final } satisfies AssistantMessageEvent);

  return stream;
}

/**
 * A provider stub that answers with `replies[n]` on its nth call and records the context it
 * was handed — which is how the multi-turn tests below check what the model actually saw,
 * rather than trusting mori's own bookkeeping.
 */
function recordingProvider(replies: string[]) {
  const contexts: Context[] = [];
  const streamFn: StreamFn = (model, context) => {
    const reply = replies[contexts.length] ?? "ok";
    contexts.push(context);
    return textStream(model as Model<never>, reply);
  };
  return { streamFn, contexts, sent: (turn: number) => JSON.stringify(contexts[turn]?.messages) };
}

/** A provider stub whose first call hangs until the run is aborted. */
function hangingThenAnswering(reply: string) {
  let calls = 0;
  const streamFn: StreamFn = (model, _context, options) => {
    if (calls++ > 0) return textStream(model as Model<never>, reply);
    return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
  };
  return { streamFn, calls: () => calls };
}

type ScriptEntry =
  | { type: "line"; value: string; interruptDuringTurn?: boolean }
  | { type: "eof" }
  | { type: "interrupt" };

/**
 * A line source driven by a fixed script instead of a terminal (TESTING.md forbids tests
 * that need a real TTY). `interruptDuringTurn` fires the Ctrl-C handler once the line has
 * been handed over — i.e. while the turn it starts is still running.
 */
function scriptedInput(script: ScriptEntry[]) {
  const handlers = new Set<() => void>();
  const prompts: string[] = [];
  const state = { closed: false };
  let next = 0;

  const source: ReplInputSource = {
    async readLine(prompt: string): Promise<ReplLine> {
      prompts.push(prompt);
      const entry = script[next++] ?? { type: "eof" };
      if (entry.type !== "line") return entry;
      if (entry.interruptDuringTurn) {
        setTimeout(() => {
          for (const handler of handlers) handler();
        }, 0);
      }
      return { type: "line", value: entry.value };
    },
    onInterrupt(handler: () => void): () => void {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close(): void {
      state.closed = true;
    },
  };

  return { source, prompts, state };
}

function captureOutput() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: (chunk: string) => out.push(chunk),
    stderr: (chunk: string) => err.push(chunk),
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

describe("runRepl", () => {
  it("carries earlier turns into the context the provider sees", async () => {
    const provider = recordingProvider(["answer one", "answer two"]);
    const input = scriptedInput([
      { type: "line", value: "question one" },
      { type: "line", value: "question two" },
      { type: "eof" },
    ]);

    const exitCode = await runRepl(testAgent(provider.streamFn), input.source, captureOutput());

    expect(exitCode).toBe(0);
    expect(provider.contexts).toHaveLength(2);
    // Turn 1's question *and* its answer must both be visible to turn 2 — the point of
    // keeping one agent alive across prompts.
    expect(provider.sent(1)).toContain("question one");
    expect(provider.sent(1)).toContain("answer one");
    expect(provider.sent(1)).toContain("question two");
  });

  it("runs every turn on the agent it was handed, accumulating one transcript", async () => {
    const provider = recordingProvider(["answer one", "answer two"]);
    const agent = testAgent(provider.streamFn);
    const input = scriptedInput([
      { type: "line", value: "question one" },
      { type: "line", value: "question two" },
      { type: "eof" },
    ]);

    await runRepl(agent, input.source, captureOutput());

    // The caller's own reference holds both turns: user, assistant, user, assistant. A
    // per-turn agent would leave this one at two messages, or empty.
    expect(agent.state.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("exits 0 on EOF", async () => {
    const provider = recordingProvider([]);
    const input = scriptedInput([{ type: "eof" }]);

    const exitCode = await runRepl(testAgent(provider.streamFn), input.source, captureOutput());

    expect(exitCode).toBe(0);
    expect(input.state.closed).toBe(true);
  });

  it("exits 0 on /exit without sending it to the provider", async () => {
    const provider = recordingProvider([]);
    const input = scriptedInput([{ type: "line", value: "/exit" }]);

    const exitCode = await runRepl(testAgent(provider.streamFn), input.source, captureOutput());

    expect(exitCode).toBe(0);
    expect(provider.contexts).toHaveLength(0);
  });

  it("drops the conversation on /clear and keeps prompting", async () => {
    const provider = recordingProvider(["answer one", "answer two"]);
    const agent = testAgent(provider.streamFn);
    const io = captureOutput();
    const input = scriptedInput([
      { type: "line", value: "question one" },
      { type: "line", value: "/clear" },
      { type: "line", value: "question two" },
      { type: "eof" },
    ]);

    const exitCode = await runRepl(agent, input.source, io);

    expect(exitCode).toBe(0);
    expect(io.out()).toContain("초기화");
    // The turn after /clear starts from nothing, and the loop went on to serve it.
    expect(provider.sent(1)).not.toContain("question one");
    expect(agent.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("ignores a blank line without calling the provider", async () => {
    const provider = recordingProvider([]);
    const input = scriptedInput([
      { type: "line", value: "" },
      { type: "line", value: "   " },
      { type: "eof" },
    ]);

    const exitCode = await runRepl(testAgent(provider.streamFn), input.source, captureOutput());

    expect(exitCode).toBe(0);
    expect(provider.contexts).toHaveLength(0);
  });

  it("cancels only the running turn on Ctrl-C and stays in the loop", async () => {
    const provider = hangingThenAnswering("answer two");
    const agent = testAgent(provider.streamFn);
    const io = captureOutput();
    const input = scriptedInput([
      { type: "line", value: "question one", interruptDuringTurn: true },
      { type: "line", value: "question two" },
      { type: "eof" },
    ]);

    const exitCode = await runRepl(agent, input.source, io);

    expect(exitCode).toBe(0);
    expect(io.err()).toContain("취소");
    // Turn 1 ends aborted; turn 2 — asked for after the cancellation — runs to completion.
    // A Ctrl-C that killed the session, or one that leaked into the next turn, breaks this.
    expect(
      agent.state.messages.map((message) =>
        message.role === "assistant" ? message.stopReason : message.role,
      ),
    ).toEqual(["user", "aborted", "user", "stop"]);
    expect(provider.calls()).toBe(2);
  });

  it("exits 0 on Ctrl-C while idle", async () => {
    const provider = recordingProvider([]);
    const input = scriptedInput([{ type: "interrupt" }]);

    const exitCode = await runRepl(testAgent(provider.streamFn), input.source, captureOutput());

    expect(exitCode).toBe(0);
    expect(input.state.closed).toBe(true);
  });
});

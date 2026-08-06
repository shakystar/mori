import type { Agent, AgentEvent, AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { BufferKernel, type ConsolidatorLlm } from "@mori/kernel";
import { describe, expect, it, vi } from "vitest";
import { createMoriAgent, type MoriKernel } from "../agent/index.js";
import { fakeProviderModels } from "../agent/fake-provider-models.js";
import type { ReplInputSource, ReplLine } from "./repl-input.js";
import { runRepl, type ReplConsolidation } from "./repl.js";

const ENV = { ANTHROPIC_API_KEY: "sk-ant-test" } as const;

/**
 * A real agent on the production wiring (kernel, model resolution, event plumbing), with
 * only the provider stream faked — via a registered fake provider (`fakeProviderModels`,
 * #336), not the `createMoriAgent(..., streamFn)` positional seam. Tools are dropped — this
 * file is about the input/output loop, and `createMoriTools` would otherwise pin a working
 * root onto every test.
 *
 * The kernel is handed back alongside the agent — `runRepl` now also takes it directly, for
 * `/consolidate` (#107) — but stays a plain `BufferKernel`: tests below that don't care about
 * consolidation pass `noConsolidation` (no `MORI_CONSOLIDATE_MODEL`, so `/consolidate` is a
 * no-op skip and `BufferKernel.consolidate()` is never reached anyway).
 */
function testAgent(streamFn: StreamFn): { agent: Agent; kernel: MoriKernel } {
  const kernel = new BufferKernel<AgentMessage, AgentEvent>();
  const credentialStore = new InMemoryCredentialStore();
  const models = fakeProviderModels(ENV, credentialStore, streamFn);
  return {
    agent: createMoriAgent(kernel, credentialStore, ENV, undefined, { tools: [], models }),
    kernel,
  };
}

/** `/consolidate`-less REPL wiring — most tests here are about the input/output loop, not it. */
function noConsolidation(kernel: MoriKernel): ReplConsolidation {
  return { kernel, llm: undefined };
}

function stubLlm(): ConsolidatorLlm {
  return { complete: async () => "[]" };
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
    const { agent, kernel } = testAgent(provider.streamFn);

    const exitCode = await runRepl(agent, input.source, captureOutput(), noConsolidation(kernel));

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
    const { agent, kernel } = testAgent(provider.streamFn);
    const input = scriptedInput([
      { type: "line", value: "question one" },
      { type: "line", value: "question two" },
      { type: "eof" },
    ]);

    await runRepl(agent, input.source, captureOutput(), noConsolidation(kernel));

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
    const { agent, kernel } = testAgent(provider.streamFn);

    const exitCode = await runRepl(agent, input.source, captureOutput(), noConsolidation(kernel));

    expect(exitCode).toBe(0);
    expect(input.state.closed).toBe(true);
  });

  it("exits 0 on /exit without sending it to the provider", async () => {
    const provider = recordingProvider([]);
    const input = scriptedInput([{ type: "line", value: "/exit" }]);
    const { agent, kernel } = testAgent(provider.streamFn);

    const exitCode = await runRepl(agent, input.source, captureOutput(), noConsolidation(kernel));

    expect(exitCode).toBe(0);
    expect(provider.contexts).toHaveLength(0);
  });

  it("drops the conversation on /clear and keeps prompting", async () => {
    const provider = recordingProvider(["answer one", "answer two"]);
    const { agent, kernel } = testAgent(provider.streamFn);
    const io = captureOutput();
    const input = scriptedInput([
      { type: "line", value: "question one" },
      { type: "line", value: "/clear" },
      { type: "line", value: "question two" },
      { type: "eof" },
    ]);

    const exitCode = await runRepl(agent, input.source, io, noConsolidation(kernel));

    expect(exitCode).toBe(0);
    expect(io.out()).toContain("초기화");
    // The turn after /clear starts from nothing, and the loop went on to serve it.
    expect(provider.sent(1)).not.toContain("question one");
    expect(agent.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("resets the kernel's conversation-scoped state on /clear, not just the agent's (#234)", async () => {
    // A BufferKernel does not itself keep injection state, but the wiring bug this
    // guards against is that `/clear` never reaches the kernel at all — a kernel
    // seam added and never called (mori#177, #215 precedent). Spying on the real
    // method (rather than swapping in a hand-written double) is what actually
    // pins the production wiring: a `resetConversation` call that silently no-ops
    // here would pass just as happily without ever reaching `repl.ts`'s `/clear`.
    const provider = recordingProvider(["answer one"]);
    const { agent, kernel } = testAgent(provider.streamFn);
    const reset = vi.spyOn(kernel, "resetConversation");
    const input = scriptedInput([
      { type: "line", value: "question one" },
      { type: "line", value: "/clear" },
      { type: "eof" },
    ]);

    const exitCode = await runRepl(agent, input.source, captureOutput(), noConsolidation(kernel));

    expect(exitCode).toBe(0);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("ignores a blank line without calling the provider", async () => {
    const provider = recordingProvider([]);
    const input = scriptedInput([
      { type: "line", value: "" },
      { type: "line", value: "   " },
      { type: "eof" },
    ]);
    const { agent, kernel } = testAgent(provider.streamFn);

    const exitCode = await runRepl(agent, input.source, captureOutput(), noConsolidation(kernel));

    expect(exitCode).toBe(0);
    expect(provider.contexts).toHaveLength(0);
  });

  it("cancels only the running turn on Ctrl-C and stays in the loop", async () => {
    const provider = hangingThenAnswering("answer two");
    const { agent, kernel } = testAgent(provider.streamFn);
    const io = captureOutput();
    const input = scriptedInput([
      { type: "line", value: "question one", interruptDuringTurn: true },
      { type: "line", value: "question two" },
      { type: "eof" },
    ]);

    const exitCode = await runRepl(agent, input.source, io, noConsolidation(kernel));

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
    const { agent, kernel } = testAgent(provider.streamFn);

    const exitCode = await runRepl(agent, input.source, captureOutput(), noConsolidation(kernel));

    expect(exitCode).toBe(0);
    expect(input.state.closed).toBe(true);
  });

  describe("/consolidate", () => {
    it("skips silently and reports nothing to consolidate when no llm is configured", async () => {
      const provider = recordingProvider([]);
      const { agent, kernel } = testAgent(provider.streamFn);
      const io = captureOutput();
      const input = scriptedInput([{ type: "line", value: "/consolidate" }, { type: "eof" }]);

      const exitCode = await runRepl(agent, input.source, io, noConsolidation(kernel));

      expect(exitCode).toBe(0);
      expect(provider.contexts).toHaveLength(0);
      expect(io.out()).toContain("설정되지 않아");
    });

    it("runs the configured llm's consolidation and confirms it, then keeps prompting", async () => {
      const provider = recordingProvider(["answer one"]);
      const { agent, kernel } = testAgent(provider.streamFn);
      const io = captureOutput();
      const input = scriptedInput([
        { type: "line", value: "/consolidate" },
        { type: "line", value: "question one" },
        { type: "eof" },
      ]);

      const exitCode = await runRepl(agent, input.source, io, { kernel, llm: stubLlm() });

      expect(exitCode).toBe(0);
      expect(io.out()).toContain("완료");
      // /consolidate did not reach the provider, but the turn right after it did.
      expect(provider.contexts).toHaveLength(1);
    });

    it("reports a failed consolidation without ending the session", async () => {
      const provider = recordingProvider([]);
      const { agent, kernel } = testAgent(provider.streamFn);
      const io = captureOutput();
      const input = scriptedInput([{ type: "line", value: "/consolidate" }, { type: "eof" }]);
      const failingLlm: ConsolidatorLlm = {
        complete: async () => {
          throw new Error("boom");
        },
      };
      // BufferKernel.consolidate() ignores its `llm` argument and never throws, so exercising
      // a failure needs a kernel that actually calls it — a thin wrapper around the real one.
      const throwingKernel: MoriKernel = {
        transformContext: (messages) => kernel.transformContext(messages),
        observe: (event) => kernel.observe(event),
        drain: () => kernel.drain(),
        resetConversation: () => kernel.resetConversation(),
        consolidate: async (llm) => {
          await llm.complete("");
        },
      };

      const exitCode = await runRepl(agent, input.source, io, {
        kernel: throwingKernel,
        llm: failingLlm,
      });

      expect(exitCode).toBe(0);
      expect(io.err()).toContain("boom");
    });

    it("cancels an in-flight consolidation on Ctrl-C without ending the session (#141)", async () => {
      const provider = recordingProvider(["answer one"]);
      const { agent, kernel } = testAgent(provider.streamFn);
      const io = captureOutput();
      const input = scriptedInput([
        { type: "line", value: "/consolidate", interruptDuringTurn: true },
        { type: "line", value: "question one" },
        { type: "eof" },
      ]);

      // Hangs until its `AbortSignal` fires, then rejects the way a real kernel's boundary
      // does once `consolidate-service.ts` sees an aborted signal at the extraction-call
      // edge — `ConsolidateAbortedError`'s `name` is `AbortError`.
      let sawAbortedSignal = false;
      const cancellableKernel: MoriKernel = {
        transformContext: (messages) => kernel.transformContext(messages),
        observe: (event) => kernel.observe(event),
        drain: () => kernel.drain(),
        resetConversation: () => kernel.resetConversation(),
        consolidate: (_llm, opts) =>
          new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener(
              "abort",
              () => {
                sawAbortedSignal = true;
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          }),
      };

      const exitCode = await runRepl(agent, input.source, io, {
        kernel: cancellableKernel,
        llm: stubLlm(),
      });

      expect(exitCode).toBe(0);
      expect(sawAbortedSignal).toBe(true);
      expect(io.err()).toContain("취소");
      // The cancelled /consolidate does not end the session — the turn right after it runs.
      expect(provider.contexts).toHaveLength(1);
    });
  });
});

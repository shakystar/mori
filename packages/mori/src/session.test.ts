import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { MoriKernel } from "./agent/index.js";
import { createMoriSession } from "./session.js";

const ENV = { ANTHROPIC_API_KEY: "sk-ant-test" } as const;

function usage(partial: Partial<Usage> = {}): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...partial,
  };
}

/**
 * A provider stub that answers with `replies[n]` (its `text` and `usage`) on its nth call,
 * and records the context it was handed — so a test can check what the model actually saw
 * (multi-turn continuity) rather than trusting the session's own bookkeeping.
 */
function scriptedProvider(replies: { text: string; usage?: Usage }[]) {
  const contexts: Context[] = [];
  const streamFn: StreamFn = (model, context) => {
    const reply = replies[contexts.length] ?? { text: "ok" };
    contexts.push(context);

    const stream = createAssistantMessageEventStream();
    const base: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: reply.usage ?? usage(),
      stopReason: "stop",
      timestamp: 0,
    };
    stream.push({ type: "start", partial: base } satisfies AssistantMessageEvent);
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: reply.text,
      partial: { ...base, content: [{ type: "text", text: reply.text }] },
    } satisfies AssistantMessageEvent);
    const final: AssistantMessage = { ...base, content: [{ type: "text", text: reply.text }] };
    stream.push({ type: "done", reason: "stop", message: final } satisfies AssistantMessageEvent);

    return stream;
  };
  return { streamFn, contexts };
}

/**
 * A provider stub for one turn whose stream never reaches `"done"` until `release()` is
 * called — the equivalent, on the provider side, of `spyKernel`'s `gateFirstConsolidate`. Holds
 * `agent.prompt()` (and so `MoriSession.prompt()`) open on purpose, so a test can call `close()`
 * while that turn is still in flight and observe what waits for what (#371).
 */
function gatedProvider(reply: { text: string; usage?: Usage }) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const streamFn: StreamFn = (model) => {
    const stream = createAssistantMessageEventStream();
    const base: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: reply.usage ?? usage(),
      stopReason: "stop",
      timestamp: 0,
    };
    stream.push({ type: "start", partial: base } satisfies AssistantMessageEvent);
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: reply.text,
      partial: { ...base, content: [{ type: "text", text: reply.text }] },
    } satisfies AssistantMessageEvent);
    const final: AssistantMessage = { ...base, content: [{ type: "text", text: reply.text }] };
    void gate.then(() => {
      stream.push({ type: "done", reason: "stop", message: final } satisfies AssistantMessageEvent);
    });

    return stream;
  };
  return { streamFn, release };
}

/**
 * A `MoriKernel` whose `consolidate`/`drain` are spies — for asserting the manual and
 * session-end triggers (#107, #341) without a real store or consolidator LLM in the loop.
 * Mirrors `index.test.ts`'s `spyKernel`. `calls` additionally records call order, so a test
 * can assert `drain()` lands before `consolidate()` on each boundary, not just call counts
 * (PR #350 owner review round 3).
 *
 * `gateFirstConsolidate` (#371) holds the FIRST `consolidate()` call open until it resolves —
 * everything after it (including any second `consolidate()` call) runs normally. That's what
 * lets a test hold a `consolidate()` trigger "in flight" on purpose, the same way a gated
 * provider stream holds a `prompt()` turn open, to check what a concurrent `close()` does
 * while it waits.
 */
function spyKernel(options: { gateFirstConsolidate?: Promise<void> } = {}): MoriKernel & {
  consolidateCalls: number;
  drainCalls: number;
  calls: string[];
} {
  let gated = false;
  const spy = {
    transformContext: async (messages: AgentMessage[]) => messages,
    observe: () => {},
    resetConversation: () => {},
    consolidateCalls: 0,
    drainCalls: 0,
    calls: [] as string[],
    async drain() {
      spy.drainCalls++;
      spy.calls.push("drain");
    },
    async consolidate() {
      if (options.gateFirstConsolidate && !gated) {
        gated = true;
        await options.gateFirstConsolidate;
      }
      spy.consolidateCalls++;
      spy.calls.push("consolidate");
    },
  };
  return spy;
}

describe("createMoriSession (#341)", () => {
  it("fails with a supported-provider message, not a thrown error, for an unknown provider", async () => {
    const errors: string[] = [];

    const result = await createMoriSession(
      { MORI_MODEL: "bogus/whatever" },
      { stderr: (chunk) => errors.push(chunk) },
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.exitCode).toBe(1);
    expect(errors.join("")).toContain("bogus");
  });

  it("runs several turns with no terminal involved, keeping earlier turns in context, and reports each turn's text/stopReason/usage", async () => {
    const provider = scriptedProvider([
      { text: "hi there", usage: usage({ input: 10, output: 5, totalTokens: 15 }) },
      { text: "still here", usage: usage({ input: 20, output: 7, totalTokens: 27 }) },
    ]);

    const result = await createMoriSession(ENV, {
      credentialStore: new InMemoryCredentialStore(),
      streamFn: provider.streamFn,
      kernel: spyKernel(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const first = await result.session.prompt("question one");
    expect(first).toEqual({
      text: "hi there",
      stopReason: "stop",
      usage: usage({ input: 10, output: 5, totalTokens: 15 }),
    });

    const second = await result.session.prompt("question two");
    expect(second).toEqual({
      text: "still here",
      stopReason: "stop",
      usage: usage({ input: 20, output: 7, totalTokens: 27 }),
    });

    // Multi-turn continuity: the second request's context contains the first turn.
    expect(provider.contexts).toHaveLength(2);
    expect(JSON.stringify(provider.contexts[1]!.messages)).toContain("question one");

    await result.session.close();
  });

  it("consolidate() triggers a manual boundary mid-session, independent of close()'s session-end trigger", async () => {
    const kernel = spyKernel();
    const provider = scriptedProvider([{ text: "ok" }]);

    const result = await createMoriSession(
      { ...ENV, MORI_CONSOLIDATE_MODEL: "anthropic/claude-x" },
      { credentialStore: new InMemoryCredentialStore(), streamFn: provider.streamFn, kernel },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await result.session.prompt("turn one");
    const outcome = await result.session.consolidate();
    expect(outcome).toEqual({ kind: "ok" });
    expect(kernel.consolidateCalls).toBe(1);

    // close()'s own session-end trigger fires a second, independent boundary.
    await result.session.close();
    expect(kernel.consolidateCalls).toBe(2);
    // Once from consolidate() itself (settles the just-finished turn's queued observation
    // before the manual boundary runs, #341 PR #350 Codex review) and once from close().
    expect(kernel.drainCalls).toBe(2);
    // Call order, not just counts: each boundary's drain() must land before its consolidate()
    // so the boundary sees everything up to that call (PR #350 owner review round 3).
    expect(kernel.calls).toEqual(["drain", "consolidate", "drain", "consolidate"]);
  });

  it("skips consolidate() as a no-op when MORI_CONSOLIDATE_MODEL is unset", async () => {
    const kernel = spyKernel();
    const provider = scriptedProvider([{ text: "ok" }]);

    const result = await createMoriSession(ENV, {
      credentialStore: new InMemoryCredentialStore(),
      streamFn: provider.streamFn,
      kernel,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const outcome = await result.session.consolidate();
    expect(outcome).toEqual({ kind: "skipped" });
    expect(kernel.consolidateCalls).toBe(0);
  });

  it("close() shares one in-flight settle across concurrent calls, and closes prompt()/consolidate() to further calls (PR #350 owner review)", async () => {
    const kernel = spyKernel();
    const provider = scriptedProvider([{ text: "ok" }]);

    const result = await createMoriSession(ENV, {
      credentialStore: new InMemoryCredentialStore(),
      streamFn: provider.streamFn,
      kernel,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Fired concurrently, not awaited one after the other: both must observe the same
    // drain()/session-end settle rather than the second racing ahead of the first's cleanup.
    const [first, second] = await Promise.all([result.session.close(), result.session.close()]);
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(kernel.drainCalls).toBe(1);

    await expect(result.session.prompt("too late")).rejects.toThrow(/close/);
    await expect(result.session.consolidate()).rejects.toThrow(/close/);
  });

  it("close() called without awaiting an in-flight prompt() waits for that turn before draining (#371)", async () => {
    const kernel = spyKernel();
    const provider = gatedProvider({ text: "hi there" });

    const result = await createMoriSession(ENV, {
      credentialStore: new InMemoryCredentialStore(),
      streamFn: provider.streamFn,
      kernel,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Neither call awaited before the next fires — the episode-timeout scenario the issue
    // describes: a caller triggers `close()` without having awaited the turn it interrupted.
    const turn = result.session.prompt("question");
    const closed = result.session.close();

    // Flush pending microtasks (not just one hop) without depending on a specific count.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The turn's stream is gated open, so it hasn't finished — close() must not have started
    // draining yet, or the turn's still-queued observation would be missed by this settle.
    expect(kernel.calls).toEqual([]);

    provider.release();
    await closed;

    expect(await turn).toEqual({ text: "hi there", stopReason: "stop", usage: usage() });
    // drain() runs exactly once, only once the turn that was in flight actually finished.
    expect(kernel.calls).toEqual(["drain"]);
  });

  it("close() called without awaiting an in-flight consolidate() waits for that boundary before its own (#371)", async () => {
    let releaseConsolidate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseConsolidate = resolve;
    });
    const kernel = spyKernel({ gateFirstConsolidate: gate });
    const provider = scriptedProvider([{ text: "ok" }]);

    const result = await createMoriSession(
      { ...ENV, MORI_CONSOLIDATE_MODEL: "anthropic/claude-x" },
      { credentialStore: new InMemoryCredentialStore(), streamFn: provider.streamFn, kernel },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await result.session.prompt("turn one");

    // Neither call awaited before the next fires.
    const consolidated = result.session.consolidate();
    const closed = result.session.close();

    await new Promise((resolve) => setTimeout(resolve, 0));

    // consolidate()'s own drain() has already run, but its consolidate() call is gated open.
    // Without #371's fix, close()'s own drain() races in here too (both triggers call drain()
    // unguarded) — this is exactly the "counts match, order doesn't" shape the issue calls out:
    // ["drain", "drain", "consolidate", "consolidate"] has the same counts as the line below.
    expect(kernel.calls).toEqual(["drain"]);

    releaseConsolidate();
    await Promise.all([consolidated, closed]);

    // Each boundary's drain() lands immediately before its own consolidate() — the two triggers
    // ran one after the other, not interleaved, even though neither call was awaited before the
    // next fired.
    expect(kernel.calls).toEqual(["drain", "consolidate", "drain", "consolidate"]);
  });
});

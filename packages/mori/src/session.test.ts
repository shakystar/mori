import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Usage,
} from "@earendil-works/pi-ai";
import {
  contentText,
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import type { ConsolidateCallOptions, ConsolidatorLlm } from "@mori/kernel";
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
 *
 * `onUsageReply` (#449) makes this double stand in for a real kernel's own `onUsage` firing —
 * a caller-supplied `opts.onUsage` (the `ConsolidateCallOptions` seam `consolidateGuarded`
 * forwards from `close()`) gets called with this value on every `consolidate()` call, the same
 * way a real kernel forwards its extractor's usage.
 */
function spyKernel(
  options: { gateFirstConsolidate?: Promise<void>; onUsageReply?: Usage } = {},
): MoriKernel & {
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
    async consolidate(_llm?: ConsolidatorLlm, opts?: ConsolidateCallOptions) {
      if (options.gateFirstConsolidate && !gated) {
        gated = true;
        await options.gateFirstConsolidate;
      }
      spy.consolidateCalls++;
      spy.calls.push("consolidate");
      if (options.onUsageReply) opts?.onUsage?.(options.onUsageReply);
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

  it("close() surfaces the session-end boundary's own distillation usage when a consolidator model is configured (#449)", async () => {
    const distillationUsage = usage({ input: 100, output: 40, totalTokens: 140 });
    const kernel = spyKernel({ onUsageReply: distillationUsage });
    const provider = scriptedProvider([{ text: "ok" }]);

    const result = await createMoriSession(
      { ...ENV, MORI_CONSOLIDATE_MODEL: "anthropic/claude-x" },
      { credentialStore: new InMemoryCredentialStore(), streamFn: provider.streamFn, kernel },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await result.session.prompt("turn one");
    const closed = await result.session.close();

    // Before #449, close() resolved `void` and this usage reached no caller at all — a bench
    // cost ledger recording `close().usage` (runner.ts) had nothing to record.
    expect(closed).toEqual({ usage: distillationUsage });
  });

  it("close() reports zero distillation usage when no consolidator model is configured (#449)", async () => {
    const kernel = spyKernel();
    const provider = scriptedProvider([{ text: "ok" }]);

    const result = await createMoriSession(ENV, {
      credentialStore: new InMemoryCredentialStore(),
      streamFn: provider.streamFn,
      kernel,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const closed = await result.session.close();

    // consolidateOnSessionEnd's `if (!llm) return` never reaches the extractor, so no
    // `onUsage` fires and the sum over zero usages is the zero value, not undefined.
    expect(closed).toEqual({ usage: usage() });
    expect(kernel.consolidateCalls).toBe(0);
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
    // Same settle, not just equal values (#449) — a second caller must see the exact object
    // the first close() produced, not a freshly recomputed one.
    expect(first).toBe(second);
    expect(first).toEqual({ usage: usage() });
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

/**
 * The compaction summarizer's own user-turn prompt text, off a recorded `Context` — the
 * `<conversation>...</conversation>` block plus the format instructions
 * (`generateSummaryWithUsage`, pi 0.82.1). `contentText` (not `JSON.stringify`) so the
 * assertion checks the actual prompt string the model would read, newlines included, rather
 * than a JSON-escaped rendering of it.
 */
function requestText(context: Context | undefined): string {
  const message = context?.messages[0];
  return message ? contentText(message.content) : "";
}

describe("MoriSession.compact() (#464, diagnosis: #462)", () => {
  // A short, multi-turn context — shorter than pi's `keepRecentTokens` (20000) budget, same
  // shape as the preference-regression bench's context sessions that surfaced #462.
  const CONTEXT_TURNS = [
    "이 함수 리뷰해줘: function add(a, b) { return a + b; }",
    "고마워, 결론만 한두 문장으로 줄여줄래.",
    "이 워닝은 뭐야: useEffect missing dependency",
    "역시 길다, 짧게.",
  ];

  it("without forceCut, a conversation shorter than keepRecentTokens still reaches the summarizer empty — pi's default path, unchanged (#462 regression net)", async () => {
    const provider = scriptedProvider(CONTEXT_TURNS.map(() => ({ text: "ok" })));

    const result = await createMoriSession(ENV, {
      credentialStore: new InMemoryCredentialStore(),
      streamFn: provider.streamFn,
      kernel: spyKernel(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const turn of CONTEXT_TURNS) await result.session.prompt(turn);

    const beforeCalls = provider.contexts.length;
    await result.session.compact();
    const compactionRequest = requestText(provider.contexts[beforeCalls]);

    // Asserting the REQUEST (what the summarizer was handed), not the stub's reply — the same
    // shape as the diagnosis's own observation B. If this ever stops being empty, `compact()`'s
    // default (no `forceCut`) has silently stopped being pi's stock path, which is exactly the
    // production-untouched guarantee #464 promised.
    expect(compactionRequest).toContain("<conversation>\n\n</conversation>");
  });

  it("forceCut:true summarizes the whole context in one call — the request the summarizer sees is not the empty-conversation boilerplate and contains the first context turn (#464)", async () => {
    const provider = scriptedProvider(CONTEXT_TURNS.map(() => ({ text: "ok" })));

    const result = await createMoriSession(ENV, {
      credentialStore: new InMemoryCredentialStore(),
      streamFn: provider.streamFn,
      kernel: spyKernel(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const turn of CONTEXT_TURNS) await result.session.prompt(turn);

    const beforeCalls = provider.contexts.length;
    await result.session.compact({ forceCut: true });
    const compactionRequest = requestText(provider.contexts[beforeCalls]);

    expect(compactionRequest).not.toContain("<conversation>\n\n</conversation>");
    expect(compactionRequest).toContain(CONTEXT_TURNS[0]);
  });

  it("prompt() after compact({ forceCut: true }) rejects — forceCut never appends the compaction to the session's own entries, so a later turn would resend the full pre-compaction history unnoticed (#464 owner review round 2)", async () => {
    const provider = scriptedProvider(CONTEXT_TURNS.map(() => ({ text: "ok" })));

    const result = await createMoriSession(ENV, {
      credentialStore: new InMemoryCredentialStore(),
      streamFn: provider.streamFn,
      kernel: spyKernel(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const turn of CONTEXT_TURNS) await result.session.prompt(turn);
    await result.session.compact({ forceCut: true });

    await expect(result.session.prompt("한 번 더")).rejects.toThrow(
      /prompt\(\) after compact\(\{ forceCut: true \}\)/,
    );
  });

  it("a failed forceCut compaction reverts forceCutUsed — the session's entries were never touched, so a later prompt() is not permanently locked out (#466)", async () => {
    const okReplies = scriptedProvider(CONTEXT_TURNS.map(() => ({ text: "ok" })));
    let failNextCall = false;
    const streamFn: StreamFn = (model, context, options) => {
      if (failNextCall) {
        failNextCall = false;
        throw new Error("rate limited");
      }
      return okReplies.streamFn(model, context, options);
    };

    const result = await createMoriSession(ENV, {
      credentialStore: new InMemoryCredentialStore(),
      streamFn,
      kernel: spyKernel(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const turn of CONTEXT_TURNS) await result.session.prompt(turn);

    failNextCall = true;
    await expect(result.session.compact({ forceCut: true })).rejects.toThrow(/rate limited/);

    // Not the "resend full pre-compaction history" guard rejection — the failed compaction
    // left forceCutUsed exactly as it was before the call.
    await expect(result.session.prompt("한 번 더")).resolves.toMatchObject({ stopReason: "stop" });
  });

  it("a failed forceCut compaction after an earlier successful one does not unlock prompt() — the successful forceCut's lock stays in force regardless of what a later failed call reverts to (#466 owner review round 2)", async () => {
    const okReplies = scriptedProvider(CONTEXT_TURNS.map(() => ({ text: "ok" })));
    let failNextCall = false;
    const streamFn: StreamFn = (model, context, options) => {
      if (failNextCall) {
        failNextCall = false;
        throw new Error("rate limited");
      }
      return okReplies.streamFn(model, context, options);
    };

    const result = await createMoriSession(ENV, {
      credentialStore: new InMemoryCredentialStore(),
      streamFn,
      kernel: spyKernel(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const turn of CONTEXT_TURNS) await result.session.prompt(turn);

    await result.session.compact({ forceCut: true });

    failNextCall = true;
    await expect(result.session.compact({ forceCut: true })).rejects.toThrow(/rate limited/);

    // The second call's failure must restore the flag to what it was BEFORE that call
    // (already `true`, from the first successful forceCut) — not unconditionally `false`.
    await expect(result.session.prompt("한 번 더")).rejects.toThrow(
      /prompt\(\) after compact\(\{ forceCut: true \}\)/,
    );
  });

  it("two overlapping forceCut compactions that both fail do not permanently lock prompt() — neither ever committed, so a snapshot-per-call restore that clobbers the other call's restore must not leave the lock stuck on (#466 owner review round 3)", async () => {
    const okReplies = scriptedProvider(CONTEXT_TURNS.map(() => ({ text: "ok" })));
    let failCalls = 0;
    const streamFn: StreamFn = (model, context, options) => {
      if (failCalls > 0) {
        failCalls -= 1;
        throw new Error("rate limited");
      }
      return okReplies.streamFn(model, context, options);
    };

    const result = await createMoriSession(ENV, {
      credentialStore: new InMemoryCredentialStore(),
      streamFn,
      kernel: spyKernel(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const turn of CONTEXT_TURNS) await result.session.prompt(turn);

    failCalls = 2;
    const a = result.session.compact({ forceCut: true });
    const b = result.session.compact({ forceCut: true });
    await expect(a).rejects.toThrow(/rate limited/);
    await expect(b).rejects.toThrow(/rate limited/);

    // Neither call ever touched the session's entries, so the session is still alive.
    await expect(result.session.prompt("한 번 더")).resolves.toMatchObject({ stopReason: "stop" });
  });
});

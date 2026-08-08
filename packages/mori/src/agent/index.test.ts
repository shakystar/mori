import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentHarness,
  type AgentEvent,
  type AgentMessage,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Credential,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { BufferKernel } from "@mori/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMoriAgent,
  createMoriModels,
  type CreateMoriAgentOptions,
  type MoriAgent,
} from "./index.js";
import { fakeProviderModels } from "./fake-provider-models.js";
import { EXPERIMENTAL_OPENAI_OAUTH_ENV, OPENAI_OAUTH_PROVIDER_ID } from "../auth/experimental.js";

const ONE_HOUR_MS = 60 * 60 * 1000;
const GATE_ON = { [EXPERIMENTAL_OPENAI_OAUTH_ENV]: "1" } as const;
const ENV = { ANTHROPIC_API_KEY: "sk-ant-test" } as const;

async function storeWith(
  credential: Credential,
  providerId = "anthropic",
): Promise<InMemoryCredentialStore> {
  const store = new InMemoryCredentialStore();
  await store.modify(providerId, async () => credential);
  return store;
}

function store(): InMemoryCredentialStore {
  return new InMemoryCredentialStore();
}

describe("createMoriModels", () => {
  it("agrees between checkAuth (the CLI gate) and getAuth (the real request path) in every case", async () => {
    // Regression test for #42: before this issue, the CLI's auth gate and the real
    // provider request read credentials independently (the gate consulted a
    // CredentialStore; the real request read process.env directly), so they could
    // disagree — most notably, a stored OAuth token satisfied the gate but the real
    // request never saw the credential store at all. Both now come from the same
    // `Models` instance (checkAuth/getAuth resolve auth via the identical
    // provider+store+authContext config), so they cannot diverge by construction.
    const cases: Array<{
      name: string;
      env: NodeJS.ProcessEnv;
      providerId?: string;
      credential?: Credential;
      expectAuthenticated: boolean;
    }> = [
      {
        name: "non-expired OAuth alone, no API key env",
        env: {},
        credential: {
          type: "oauth",
          access: "at-valid",
          refresh: "rt-valid",
          expires: Date.now() + ONE_HOUR_MS,
        },
        expectAuthenticated: false, // #16: subscription OAuth is never wired into a real request
      },
      {
        // #44: `hidingOAuth` used to hide stored OAuth for *every* provider, which was safe
        // only while no registered provider could authenticate with it. openai-codex can —
        // OAuth is its sole auth method — so hiding it there would leave `mori login`
        // reporting success while every request stayed unauthenticated. These two cases sit
        // side by side to pin down that narrowing the wrapper did not weaken #16.
        name: "openai-codex with a non-expired stored OAuth token, gate on",
        env: { ...GATE_ON },
        providerId: OPENAI_OAUTH_PROVIDER_ID,
        credential: {
          type: "oauth",
          access: "at-valid",
          refresh: "rt-valid",
          expires: Date.now() + ONE_HOUR_MS,
        },
        expectAuthenticated: true,
      },
      {
        name: "anthropic with a non-expired stored OAuth token, gate on",
        env: { ...GATE_ON },
        credential: {
          type: "oauth",
          access: "at-valid",
          refresh: "rt-valid",
          expires: Date.now() + ONE_HOUR_MS,
        },
        expectAuthenticated: false, // #16 still holds with the gate on
      },
      {
        name: "non-expired OAuth, valid API key env",
        env: { ANTHROPIC_API_KEY: "sk-ant-test" },
        credential: {
          type: "oauth",
          access: "at-valid",
          refresh: "rt-valid",
          expires: Date.now() + ONE_HOUR_MS,
        },
        expectAuthenticated: true, // stored OAuth must never shadow a valid API key (#42 review)
      },
      {
        name: "expired OAuth, valid API key env",
        env: { ANTHROPIC_API_KEY: "sk-ant-test" },
        credential: {
          type: "oauth",
          access: "at-expired",
          refresh: "rt-expired",
          expires: Date.now() - ONE_HOUR_MS,
        },
        expectAuthenticated: true,
      },
      {
        name: "nothing stored, valid API key env",
        env: { ANTHROPIC_API_KEY: "sk-ant-test" },
        expectAuthenticated: true,
      },
      {
        name: "nothing stored, no API key env",
        env: {},
        expectAuthenticated: false,
      },
    ];

    for (const { name, env, providerId = "anthropic", credential, expectAuthenticated } of cases) {
      const store = credential
        ? await storeWith(credential, providerId)
        : new InMemoryCredentialStore();
      const models = createMoriModels(env, store);

      const gate = await models.checkAuth(providerId);
      const real = await models.getAuth(providerId);

      expect(Boolean(gate), name).toBe(expectAuthenticated);
      expect(Boolean(real), name).toBe(expectAuthenticated);
    }
  });

  it("does not register the experimental OpenAI OAuth provider when the gate is off", async () => {
    // #44's most important guarantee: with no configuration, `openai-codex` is not
    // constructed at all, so it cannot appear in a provider list or a model lookup.
    const models = createMoriModels({}, new InMemoryCredentialStore());

    expect(models.getProvider(OPENAI_OAUTH_PROVIDER_ID)).toBeUndefined();
    expect(models.getProviders().map((provider) => provider.id)).toEqual(["anthropic", "openai"]);
    expect(models.getModels().some((model) => model.provider === OPENAI_OAUTH_PROVIDER_ID)).toBe(
      false,
    );
  });

  it("registers the experimental OpenAI OAuth provider with OAuth as its only auth method when the gate is on", async () => {
    const models = createMoriModels({ ...GATE_ON }, new InMemoryCredentialStore());

    const provider = models.getProvider(OPENAI_OAUTH_PROVIDER_ID);
    expect(provider?.auth.oauth).toBeDefined();
    // It has no API key auth, so nothing may try to resolve one for it (#35 §4-2).
    expect(provider?.auth.apiKey).toBeUndefined();
  });

  it("never exposes an OAuth login handler for anthropic, gate on or off (#16)", async () => {
    for (const env of [{}, { ...GATE_ON }]) {
      const models = createMoriModels(env, new InMemoryCredentialStore());
      expect(models.getProvider("anthropic")?.auth.oauth).toBeUndefined();
    }
  });

  it("resolves the API key from the injected env, not ambient process.env", async () => {
    const store = new InMemoryCredentialStore();
    const models = createMoriModels({ ANTHROPIC_API_KEY: "sk-ant-injected" }, store);

    const auth = await models.getAuth("anthropic");

    expect(auth?.auth.apiKey).toBe("sk-ant-injected");
  });
});

/** Fake streamFn that completes immediately, echoing the requested model/provider back. */
function fakeStreamFn(): StreamFn {
  return (model) => {
    const stream = createAssistantMessageEventStream();
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage,
      stopReason: "stop",
      timestamp: 0,
    };
    stream.push({ type: "start", partial: message } satisfies AssistantMessageEvent);
    stream.push({ type: "done", reason: "stop", message } satisfies AssistantMessageEvent);
    return stream;
  };
}

function kernel() {
  return new BufferKernel<AgentMessage, AgentEvent>();
}

/**
 * A `BufferKernel` that also records what its retrieval hook was handed. Used by the
 * harness-contract case below to see the `context` hook fire — and with which arguments,
 * since the run's `AbortSignal` reaches it by a different route on the harness than it did
 * on the low-level `Agent` (agent/index.ts's `runSignal`).
 */
class RecordingKernel extends BufferKernel<AgentMessage, AgentEvent> {
  readonly contexts: Array<{ messages: AgentMessage[]; signal: AbortSignal | undefined }> = [];

  override async transformContext(
    messages: AgentMessage[],
    signal?: AbortSignal,
  ): Promise<AgentMessage[]> {
    this.contexts.push({ messages, signal });
    return messages;
  }
}

const USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type FakeTurn =
  | { toolCall: { name: string; arguments: Record<string, unknown> } }
  | { toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> }
  | { text: string };

/**
 * Fake streamFn that plays back one scripted turn per call — one or more tool calls in
 * a single assistant message, or a final text response — reusing the last turn once the
 * script runs out. This lets a test drive a whole prompt -> tool_call -> tool_result ->
 * final_text round trip without a live model.
 */
function scriptedStreamFn(turns: FakeTurn[]): StreamFn {
  let call = 0;
  return (model) => {
    const turn = turns[call] ?? turns.at(-1)!;
    call++;

    const stream = createAssistantMessageEventStream();
    const base = {
      role: "assistant" as const,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: USAGE,
      timestamp: 0,
    };

    if ("toolCall" in turn) {
      const toolCall: ToolCall = {
        type: "toolCall",
        id: `call-${call}`,
        name: turn.toolCall.name,
        arguments: turn.toolCall.arguments,
      };
      const message: AssistantMessage = { ...base, content: [toolCall], stopReason: "toolUse" };
      stream.push({ type: "start", partial: message } satisfies AssistantMessageEvent);
      stream.push({ type: "done", reason: "toolUse", message } satisfies AssistantMessageEvent);
    } else if ("toolCalls" in turn) {
      const toolCalls: ToolCall[] = turn.toolCalls.map((tc, i) => ({
        type: "toolCall",
        id: `call-${call}-${i}`,
        name: tc.name,
        arguments: tc.arguments,
      }));
      const message: AssistantMessage = { ...base, content: toolCalls, stopReason: "toolUse" };
      stream.push({ type: "start", partial: message } satisfies AssistantMessageEvent);
      stream.push({ type: "done", reason: "toolUse", message } satisfies AssistantMessageEvent);
    } else {
      const message: AssistantMessage = {
        ...base,
        content: [{ type: "text", text: turn.text }],
        stopReason: "stop",
      };
      stream.push({ type: "start", partial: message } satisfies AssistantMessageEvent);
      stream.push({ type: "done", reason: "stop", message } satisfies AssistantMessageEvent);
    }

    return stream;
  };
}

/**
 * Captures every message the harness appends via `message_end` — the equivalent of the
 * pre-harness `Agent`'s `state.messages` (#381's adapter, removed by #398). Must be
 * registered before the `prompt()` call it needs to see.
 */
function collectMessages(agent: MoriAgent): AgentMessage[] {
  const messages: AgentMessage[] = [];
  agent.subscribe((event) => {
    if (event.type === "message_end") messages.push(event.message);
  });
  return messages;
}

function toolResultsOf(messages: AgentMessage[]): ToolResultMessage[] {
  return messages.filter(
    (m): m is ToolResultMessage => (m as { role?: string }).role === "toolResult",
  );
}

/**
 * `createMoriAgent` with the provider stream faked by registering it on the `Models` the
 * agent resolves through (#336's `fakeProviderModels`), rather than by handing the
 * positional `streamFn` argument past `Models` entirely. Same production wiring otherwise.
 *
 * `fakeProviderModels` does not fake auth, so `ENV` carries a key exactly as a real request
 * would need — `Models#streamSimple` resolves credentials before it ever reaches the double.
 * The double rides the `anthropic` provider; the two cases below that select `openai` (or an
 * unknown provider) never reach a stream, so which provider carries it is immaterial there.
 */
function agentWith(
  moriKernel: ReturnType<typeof kernel>,
  env: NodeJS.ProcessEnv,
  streamFn: StreamFn,
  options: CreateMoriAgentOptions = {},
): MoriAgent {
  const credentialStore = store();
  const fullEnv = { ...ENV, ...env };
  return createMoriAgent(moriKernel, credentialStore, fullEnv, undefined, {
    ...options,
    models: fakeProviderModels(fullEnv, credentialStore, streamFn),
  });
}

describe("createMoriAgent", () => {
  it("defaults to the anthropic provider and claude-sonnet-4-6 when MORI_MODEL is unset", () => {
    const agent = agentWith(kernel(), {}, fakeStreamFn());
    expect(agent.getModel().provider).toBe("anthropic");
    expect(agent.getModel().id).toBe("claude-sonnet-4-6");
  });

  it("reads a bare MORI_MODEL as an anthropic model id (pre-existing form)", () => {
    const agent = agentWith(kernel(), { MORI_MODEL: "claude-opus-5" }, fakeStreamFn());
    expect(agent.getModel().provider).toBe("anthropic");
    expect(agent.getModel().id).toBe("claude-opus-5");
  });

  it("selects the openai provider and model from 'openai/<model>'", () => {
    const agent = agentWith(kernel(), { MORI_MODEL: "openai/gpt-5.4" }, fakeStreamFn());
    expect(agent.getModel().provider).toBe("openai");
    expect(agent.getModel().id).toBe("gpt-5.4");
  });

  it("throws a plain, supported-list error for an unknown provider", () => {
    expect(() => agentWith(kernel(), { MORI_MODEL: "bogus/whatever" }, fakeStreamFn())).toThrow(
      /지원하는 프로바이더.*anthropic.*openai/s,
    );
  });

  it("throws a plain, available-models error for an unknown model on a known provider", () => {
    expect(() =>
      agentWith(kernel(), { MORI_MODEL: "openai/not-a-real-model" }, fakeStreamFn()),
    ).toThrow(/openai/);
  });

  it("doesn't hang when a double ends its stream via `.end(message)` instead of pushing a terminal event (#367)", async () => {
    const streamFn: StreamFn = (model) => {
      const inner = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: USAGE,
        stopReason: "stop",
        timestamp: 0,
      };
      inner.push({ type: "start", partial: message } satisfies AssistantMessageEvent);
      // Ends via `.end(message)` rather than pushing a terminal `done`/`error` event —
      // `adaptStreamFn` (fake-provider-models.ts) must forward this past its outer stream,
      // or the outer stream never resolves and `agent.prompt()` hangs (Codex P2, #367).
      inner.end(message);
      return inner;
    };

    // Raced against a short timer rather than relying on the suite's own test timeout to
    // catch a hang — a hang here should fail with a clear assertion, not a slow, generic
    // "Test timed out" report.
    const outcome = await Promise.race([
      agentWith(kernel(), {}, streamFn)
        .prompt("hi")
        .then(() => "resolved" as const),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 500)),
    ]);
    expect(outcome).toBe("resolved");
  });

  it("returns an AgentHarness whose context / tool_call / subscribe wiring all fire (#381)", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mori-agent-harness-")));
    try {
      const k = new RecordingKernel();
      const agent = agentWith(
        k,
        {},
        scriptedStreamFn([
          { toolCall: { name: "bash", arguments: { command: "rm -rf /" } } },
          { text: "understood, I won't run that" },
        ]),
        { root },
      );

      expect(agent).toBeInstanceOf(AgentHarness);

      const messages = collectMessages(agent);
      await agent.prompt("clean up the disk");

      // `context` — the kernel's per-turn retrieval hook ran, on this turn's prompt. On the
      // low-level `Agent` this was the `transformContext` option; on the harness it is the
      // `context` hook, and nothing else in mori registers one.
      expect(k.contexts).not.toHaveLength(0);
      expect(JSON.stringify(k.contexts[0]?.messages)).toContain("clean up the disk");
      // `ContextEvent` carries no signal, so this one arrives via `subscribe`'s second
      // argument (`agent_start`) instead. Its absence is the regression that would make a
      // cancelled turn spend a retrieval attempt anyway.
      expect(k.contexts[0]?.signal).toBeInstanceOf(AbortSignal);

      // `tool_call` — the bash guard is the only thing that turns `rm -rf /` into an error
      // tool result instead of a shell command, so an error here means the hook fired.
      const [toolResult] = toolResultsOf(messages);
      expect(toolResult?.isError).toBe(true);
      expect(toolResult?.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("rm-root"),
      });

      // `subscribe` — loop events reached the kernel's observer, narrowed back to
      // `AgentEvent` from the wider `AgentHarnessEvent` the harness emits.
      expect(k.events.map((event) => event.type)).toContain("agent_end");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resetSession() moves the leaf on the same harness instance — subscriptions registered before it keep firing after (human decision #7, #398)", async () => {
    const agent = agentWith(
      kernel(),
      {},
      scriptedStreamFn([{ text: "first" }, { text: "second" }]),
    );

    const agentEnds: number[] = [];
    agent.subscribe((event) => {
      if (event.type === "agent_end") agentEnds.push(agentEnds.length);
    });

    await agent.prompt("one");
    await agent.resetSession();

    // Not a new instance: `resetSession()` (`Session.moveTo(null)`) is the "swap the
    // session while keeping the harness" branch — the rejected alternative was rebuilding
    // the harness, which would drop this very subscription (harness-session.ts).
    expect(agent).toBeInstanceOf(AgentHarness);

    await agent.prompt("two");

    // The subscription registered before resetSession() fired for both the pre- and
    // post-reset run — it was never re-registered.
    expect(agentEnds).toEqual([0, 1]);
  });

  it("getEntries() still returns pre-resetSession() entries — moveTo(null) does not delete (human decision #7 condition 3, #398)", async () => {
    const agent = agentWith(kernel(), {}, scriptedStreamFn([{ text: "answer one" }]));

    await agent.prompt("question one");
    const beforeReset = await agent.getEntries();
    expect(
      beforeReset.some(
        (entry) =>
          entry.type === "message" && JSON.stringify(entry.message).includes("question one"),
      ),
    ).toBe(true);

    await agent.resetSession();

    // The product promise is "no destruction" — resetSession() must not retract an entry
    // already readable through getEntries(). `Session.moveTo(null)` only ever appends a
    // `leaf` entry (harness-session.ts).
    const afterReset = await agent.getEntries();
    expect(afterReset.length).toBeGreaterThanOrEqual(beforeReset.length);
    expect(
      afterReset.some(
        (entry) =>
          entry.type === "message" && JSON.stringify(entry.message).includes("question one"),
      ),
    ).toBe(true);
  });
});

describe("createMoriAgent toolset wiring", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "mori-agent-toolset-")));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("runs a read_file tool_call end-to-end and returns the file content as the tool result", async () => {
    writeFileSync(join(root, "hello.txt"), "hello from disk", "utf8");
    const agent = agentWith(
      kernel(),
      {},
      scriptedStreamFn([
        { toolCall: { name: "read_file", arguments: { path: "hello.txt" } } },
        { text: "the file says hello" },
      ]),
      { root },
    );

    const messages = collectMessages(agent);
    const last = await agent.prompt("read hello.txt");

    const [toolResult] = toolResultsOf(messages);
    expect(toolResult?.toolName).toBe("read_file");
    expect(toolResult?.isError).toBe(false);
    expect(toolResult?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("hello from disk"),
    });

    expect(last).toMatchObject({ role: "assistant", stopReason: "stop" });
  });

  it("blocks a destructive bash command via beforeToolCall and keeps the agent alive", async () => {
    const agent = agentWith(
      kernel(),
      {},
      scriptedStreamFn([
        { toolCall: { name: "bash", arguments: { command: "rm -rf /" } } },
        { text: "understood, I won't run that" },
      ]),
      { root },
    );

    const messages = collectMessages(agent);
    const last = await agent.prompt("clean up the disk");

    const [toolResult] = toolResultsOf(messages);
    expect(toolResult?.isError).toBe(true);
    expect(toolResult?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("rm-root"),
    });

    expect(last).toMatchObject({ role: "assistant", stopReason: "stop" });
  });

  it("doesn't kill the agent when a tool call fails internally (file not found)", async () => {
    const agent = agentWith(
      kernel(),
      {},
      scriptedStreamFn([
        { toolCall: { name: "read_file", arguments: { path: "does-not-exist.txt" } } },
        { text: "that file doesn't exist" },
      ]),
      { root },
    );

    const messages = collectMessages(agent);
    const last = await agent.prompt("read a missing file");

    const [toolResult] = toolResultsOf(messages);
    expect(toolResult?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("file not found"),
    });

    expect(last).toMatchObject({ role: "assistant", stopReason: "stop" });
  });

  it("threads the injected root to both the path guard and bash's cwd", async () => {
    const agent = agentWith(
      kernel(),
      {},
      scriptedStreamFn([
        { toolCall: { name: "bash", arguments: { command: "pwd" } } },
        { text: "done" },
      ]),
      { root },
    );

    const messages = collectMessages(agent);
    await agent.prompt("where are we running");

    const [toolResult] = toolResultsOf(messages);
    expect(toolResult?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(root),
    });
  });

  it("surfaces tool_execution_start/tool_execution_end events to kernel.observe()", async () => {
    writeFileSync(join(root, "hello.txt"), "hi", "utf8");
    const k = kernel();
    const agent = agentWith(
      k,
      {},
      scriptedStreamFn([
        { toolCall: { name: "read_file", arguments: { path: "hello.txt" } } },
        { text: "done" },
      ]),
      { root },
    );

    await agent.prompt("read hello.txt");

    const observedTypes = k.events.map((event) => event.type);
    expect(observedTypes).toContain("tool_execution_start");
    expect(observedTypes).toContain("tool_execution_end");
  });

  it("registering an empty tool list preserves single-prompt behavior (regression)", async () => {
    const agent = agentWith(kernel(), {}, scriptedStreamFn([{ text: "just talking, no tools" }]), {
      root,
      tools: [],
    });

    const messages = collectMessages(agent);
    const last = await agent.prompt("hi");

    expect(agent.getTools()).toEqual([]);
    expect(toolResultsOf(messages)).toHaveLength(0);
    expect(last).toMatchObject({ role: "assistant", stopReason: "stop" });
  });
});

describe("bash/edit_file tool-level executionMode: sequential (#320)", () => {
  it("runs bash + read_file from one assistant message sequentially on the agent mori actually builds, which sets no toolExecution", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mori-agent-execmode-")));
    try {
      writeFileSync(join(root, "hello.txt"), "hello from disk", "utf8");

      // The agent under test is the production one (`createMoriAgent`), not a hand-built
      // `Agent`. That is the whole point since #381: `createMoriAgent` used to pass
      // `toolExecution: "sequential"` and now cannot — `AgentHarness` does not take it — so
      // this case is what says the migration did not quietly hand the batch back to pi's
      // parallel default. It rides `executionMode: "sequential"` on the bash/edit_file tool
      // definitions (#320) and nothing else.
      const agent = agentWith(
        kernel(),
        {},
        scriptedStreamFn([
          {
            toolCalls: [
              { name: "bash", arguments: { command: "true" } },
              { name: "read_file", arguments: { path: "hello.txt" } },
            ],
          },
          { text: "done" },
        ]),
        { root },
      );

      const events: string[] = [];
      agent.subscribe((event) => {
        if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
          events.push(
            `${event.type === "tool_execution_start" ? "start" : "end"}:${event.toolName}`,
          );
        }
      });

      await agent.prompt("run bash then read the file");

      // Parallel execution (pi's default with no toolExecution set) would start both
      // calls before either finishes. bash's executionMode: "sequential" must force the
      // whole batch sequential regardless, so read_file's start only follows bash's end.
      expect(events).toEqual(["start:bash", "end:bash", "start:read_file", "end:read_file"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

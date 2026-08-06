import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
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
import { createMoriAgent, createMoriModels } from "./index.js";
import { EXPERIMENTAL_OPENAI_OAUTH_ENV, OPENAI_OAUTH_PROVIDER_ID } from "../auth/experimental.js";
import { createBashTool } from "../tools/bash.js";
import { createReadFileTool } from "../tools/read-file.js";

const ONE_HOUR_MS = 60 * 60 * 1000;
const GATE_ON = { [EXPERIMENTAL_OPENAI_OAUTH_ENV]: "1" } as const;

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

function toolResultsOf(agent: { state: { messages: AgentMessage[] } }): ToolResultMessage[] {
  return agent.state.messages.filter(
    (m): m is ToolResultMessage => (m as { role?: string }).role === "toolResult",
  );
}

describe("createMoriAgent", () => {
  it("defaults to the anthropic provider and claude-sonnet-4-6 when MORI_MODEL is unset", () => {
    const agent = createMoriAgent(kernel(), store(), {}, fakeStreamFn());
    expect(agent.state.model.provider).toBe("anthropic");
    expect(agent.state.model.id).toBe("claude-sonnet-4-6");
  });

  it("reads a bare MORI_MODEL as an anthropic model id (pre-existing form)", () => {
    const agent = createMoriAgent(
      kernel(),
      store(),
      { MORI_MODEL: "claude-opus-5" },
      fakeStreamFn(),
    );
    expect(agent.state.model.provider).toBe("anthropic");
    expect(agent.state.model.id).toBe("claude-opus-5");
  });

  it("selects the openai provider and model from 'openai/<model>'", () => {
    const agent = createMoriAgent(
      kernel(),
      store(),
      { MORI_MODEL: "openai/gpt-5.4" },
      fakeStreamFn(),
    );
    expect(agent.state.model.provider).toBe("openai");
    expect(agent.state.model.id).toBe("gpt-5.4");
  });

  it("throws a plain, supported-list error for an unknown provider", () => {
    expect(() =>
      createMoriAgent(kernel(), store(), { MORI_MODEL: "bogus/whatever" }, fakeStreamFn()),
    ).toThrow(/지원하는 프로바이더.*anthropic.*openai/s);
  });

  it("throws a plain, available-models error for an unknown model on a known provider", () => {
    expect(() =>
      createMoriAgent(kernel(), store(), { MORI_MODEL: "openai/not-a-real-model" }, fakeStreamFn()),
    ).toThrow(/openai/);
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
    const agent = createMoriAgent(
      kernel(),
      store(),
      {},
      scriptedStreamFn([
        { toolCall: { name: "read_file", arguments: { path: "hello.txt" } } },
        { text: "the file says hello" },
      ]),
      { root },
    );

    await agent.prompt("read hello.txt");

    const [toolResult] = toolResultsOf(agent);
    expect(toolResult?.toolName).toBe("read_file");
    expect(toolResult?.isError).toBe(false);
    expect(toolResult?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("hello from disk"),
    });

    const last = agent.state.messages.at(-1);
    expect(last).toMatchObject({ role: "assistant", stopReason: "stop" });
  });

  it("blocks a destructive bash command via beforeToolCall and keeps the agent alive", async () => {
    const agent = createMoriAgent(
      kernel(),
      store(),
      {},
      scriptedStreamFn([
        { toolCall: { name: "bash", arguments: { command: "rm -rf /" } } },
        { text: "understood, I won't run that" },
      ]),
      { root },
    );

    await agent.prompt("clean up the disk");

    const [toolResult] = toolResultsOf(agent);
    expect(toolResult?.isError).toBe(true);
    expect(toolResult?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("rm-root"),
    });

    const last = agent.state.messages.at(-1);
    expect(last).toMatchObject({ role: "assistant", stopReason: "stop" });
  });

  it("doesn't kill the agent when a tool call fails internally (file not found)", async () => {
    const agent = createMoriAgent(
      kernel(),
      store(),
      {},
      scriptedStreamFn([
        { toolCall: { name: "read_file", arguments: { path: "does-not-exist.txt" } } },
        { text: "that file doesn't exist" },
      ]),
      { root },
    );

    await agent.prompt("read a missing file");

    const [toolResult] = toolResultsOf(agent);
    expect(toolResult?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("file not found"),
    });

    const last = agent.state.messages.at(-1);
    expect(last).toMatchObject({ role: "assistant", stopReason: "stop" });
  });

  it("threads the injected root to both the path guard and bash's cwd", async () => {
    const agent = createMoriAgent(
      kernel(),
      store(),
      {},
      scriptedStreamFn([
        { toolCall: { name: "bash", arguments: { command: "pwd" } } },
        { text: "done" },
      ]),
      { root },
    );

    await agent.prompt("where are we running");

    const [toolResult] = toolResultsOf(agent);
    expect(toolResult?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(root),
    });
  });

  it("surfaces tool_execution_start/tool_execution_end events to kernel.observe()", async () => {
    writeFileSync(join(root, "hello.txt"), "hi", "utf8");
    const k = kernel();
    const agent = createMoriAgent(
      k,
      store(),
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
    const agent = createMoriAgent(
      kernel(),
      store(),
      {},
      scriptedStreamFn([{ text: "just talking, no tools" }]),
      {
        root,
        tools: [],
      },
    );

    await agent.prompt("hi");

    expect(agent.state.tools).toEqual([]);
    expect(toolResultsOf(agent)).toHaveLength(0);
    const last = agent.state.messages.at(-1);
    expect(last).toMatchObject({ role: "assistant", stopReason: "stop" });
  });
});

describe("bash/edit_file tool-level executionMode: sequential (#320)", () => {
  it("runs bash + read_file from one assistant message sequentially even on a plain Agent that doesn't set toolExecution", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mori-agent-execmode-")));
    try {
      writeFileSync(join(root, "hello.txt"), "hello from disk", "utf8");

      const model = createMoriModels({}, store()).getModel("anthropic", "claude-sonnet-4-6");
      if (!model) throw new Error("expected the default anthropic model to be registered");

      const events: string[] = [];
      const agent = new Agent({
        initialState: {
          systemPrompt: "test",
          model,
          tools: [createBashTool(root), createReadFileTool(root)],
        },
        streamFn: scriptedStreamFn([
          {
            toolCalls: [
              { name: "bash", arguments: { command: "true" } },
              { name: "read_file", arguments: { path: "hello.txt" } },
            ],
          },
          { text: "done" },
        ]),
      });
      agent.subscribe((event) => {
        if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
          events.push(`${event.type === "tool_execution_start" ? "start" : "end"}:${event.toolName}`);
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

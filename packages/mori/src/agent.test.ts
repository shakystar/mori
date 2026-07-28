import type { AgentEvent, AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, Credential } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { BufferKernel } from "@mori/kernel";
import { describe, expect, it } from "vitest";
import { createMoriAgent, createMoriModels } from "./agent.js";

const ONE_HOUR_MS = 60 * 60 * 1000;

async function storeWith(credential: Credential): Promise<InMemoryCredentialStore> {
  const store = new InMemoryCredentialStore();
  await store.modify("anthropic", async () => credential);
  return store;
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
    const cases: Array<{ name: string; env: NodeJS.ProcessEnv; credential?: Credential; expectAuthenticated: boolean }> = [
      {
        name: "non-expired OAuth alone, no API key env",
        env: {},
        credential: { type: "oauth", access: "at-valid", refresh: "rt-valid", expires: Date.now() + ONE_HOUR_MS },
        expectAuthenticated: false, // #16: subscription OAuth is never wired into a real request
      },
      {
        name: "non-expired OAuth, valid API key env",
        env: { ANTHROPIC_API_KEY: "sk-ant-test" },
        credential: { type: "oauth", access: "at-valid", refresh: "rt-valid", expires: Date.now() + ONE_HOUR_MS },
        expectAuthenticated: true, // stored OAuth must never shadow a valid API key (#42 review)
      },
      {
        name: "expired OAuth, valid API key env",
        env: { ANTHROPIC_API_KEY: "sk-ant-test" },
        credential: { type: "oauth", access: "at-expired", refresh: "rt-expired", expires: Date.now() - ONE_HOUR_MS },
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

    for (const { env, credential, expectAuthenticated } of cases) {
      const store = credential ? await storeWith(credential) : new InMemoryCredentialStore();
      const models = createMoriModels(env, store);

      const gate = await models.checkAuth("anthropic");
      const real = await models.getAuth("anthropic");

      expect(Boolean(gate)).toBe(expectAuthenticated);
      expect(Boolean(real)).toBe(expectAuthenticated);
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

describe("createMoriAgent", () => {
  function store() {
    return new InMemoryCredentialStore();
  }

  it("defaults to the anthropic provider and claude-sonnet-4-6 when MORI_MODEL is unset", () => {
    const agent = createMoriAgent(kernel(), store(), {}, fakeStreamFn());
    expect(agent.state.model.provider).toBe("anthropic");
    expect(agent.state.model.id).toBe("claude-sonnet-4-6");
  });

  it("reads a bare MORI_MODEL as an anthropic model id (pre-existing form)", () => {
    const agent = createMoriAgent(kernel(), store(), { MORI_MODEL: "claude-opus-5" }, fakeStreamFn());
    expect(agent.state.model.provider).toBe("anthropic");
    expect(agent.state.model.id).toBe("claude-opus-5");
  });

  it("selects the openai provider and model from 'openai/<model>'", () => {
    const agent = createMoriAgent(kernel(), store(), { MORI_MODEL: "openai/gpt-5.4" }, fakeStreamFn());
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

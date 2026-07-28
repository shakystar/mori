import type { AgentEvent, AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { BufferKernel } from "@mori/kernel";
import { describe, expect, it } from "vitest";
import { createMoriAgent } from "./agent.js";

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
  it("defaults to the anthropic provider and claude-sonnet-4-6 when MORI_MODEL is unset", () => {
    const agent = createMoriAgent(kernel(), {}, fakeStreamFn());
    expect(agent.state.model.provider).toBe("anthropic");
    expect(agent.state.model.id).toBe("claude-sonnet-4-6");
  });

  it("reads a bare MORI_MODEL as an anthropic model id (pre-existing form)", () => {
    const agent = createMoriAgent(kernel(), { MORI_MODEL: "claude-opus-5" }, fakeStreamFn());
    expect(agent.state.model.provider).toBe("anthropic");
    expect(agent.state.model.id).toBe("claude-opus-5");
  });

  it("selects the openai provider and model from 'openai/<model>'", () => {
    const agent = createMoriAgent(kernel(), { MORI_MODEL: "openai/gpt-5.4" }, fakeStreamFn());
    expect(agent.state.model.provider).toBe("openai");
    expect(agent.state.model.id).toBe("gpt-5.4");
  });

  it("throws a plain, supported-list error for an unknown provider", () => {
    expect(() =>
      createMoriAgent(kernel(), { MORI_MODEL: "bogus/whatever" }, fakeStreamFn()),
    ).toThrow(/지원하는 프로바이더.*anthropic.*openai/s);
  });

  it("throws a plain, available-models error for an unknown model on a known provider", () => {
    expect(() =>
      createMoriAgent(kernel(), { MORI_MODEL: "openai/not-a-real-model" }, fakeStreamFn()),
    ).toThrow(/openai/);
  });
});

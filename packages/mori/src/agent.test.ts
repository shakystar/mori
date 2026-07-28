import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { BufferKernel } from "@mori/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

const USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type FakeTurn = { toolCall: { name: string; arguments: Record<string, unknown> } } | { text: string };

/**
 * Fake streamFn that plays back one scripted turn per call — a single tool call or a
 * final text response — reusing the last turn once the script runs out. This lets a
 * test drive a whole prompt -> tool_call -> tool_result -> final_text round trip
 * without a live model.
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
    } else {
      const message: AssistantMessage = { ...base, content: [{ type: "text", text: turn.text }], stopReason: "stop" };
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
    expect(() => createMoriAgent(kernel(), { MORI_MODEL: "bogus/whatever" }, fakeStreamFn())).toThrow(
      /지원하는 프로바이더.*anthropic.*openai/s,
    );
  });

  it("throws a plain, available-models error for an unknown model on a known provider", () => {
    expect(() => createMoriAgent(kernel(), { MORI_MODEL: "openai/not-a-real-model" }, fakeStreamFn())).toThrow(
      /openai/,
    );
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
    expect(toolResult?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("hello from disk") });

    const last = agent.state.messages.at(-1);
    expect(last).toMatchObject({ role: "assistant", stopReason: "stop" });
  });

  it("blocks a destructive bash command via beforeToolCall and keeps the agent alive", async () => {
    const agent = createMoriAgent(
      kernel(),
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
    expect(toolResult?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("rm-root") });

    const last = agent.state.messages.at(-1);
    expect(last).toMatchObject({ role: "assistant", stopReason: "stop" });
  });

  it("doesn't kill the agent when a tool call fails internally (file not found)", async () => {
    const agent = createMoriAgent(
      kernel(),
      {},
      scriptedStreamFn([
        { toolCall: { name: "read_file", arguments: { path: "does-not-exist.txt" } } },
        { text: "that file doesn't exist" },
      ]),
      { root },
    );

    await agent.prompt("read a missing file");

    const [toolResult] = toolResultsOf(agent);
    expect(toolResult?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("file not found") });

    const last = agent.state.messages.at(-1);
    expect(last).toMatchObject({ role: "assistant", stopReason: "stop" });
  });

  it("threads the injected root to both the path guard and bash's cwd", async () => {
    const agent = createMoriAgent(
      kernel(),
      {},
      scriptedStreamFn([{ toolCall: { name: "bash", arguments: { command: "pwd" } } }, { text: "done" }]),
      { root },
    );

    await agent.prompt("where are we running");

    const [toolResult] = toolResultsOf(agent);
    expect(toolResult?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(root) });
  });

  it("surfaces tool_execution_start/tool_execution_end events to kernel.observe()", async () => {
    writeFileSync(join(root, "hello.txt"), "hi", "utf8");
    const k = kernel();
    const agent = createMoriAgent(
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
    const agent = createMoriAgent(kernel(), {}, scriptedStreamFn([{ text: "just talking, no tools" }]), {
      root,
      tools: [],
    });

    await agent.prompt("hi");

    expect(agent.state.tools).toEqual([]);
    expect(toolResultsOf(agent)).toHaveLength(0);
    const last = agent.state.messages.at(-1);
    expect(last).toMatchObject({ role: "assistant", stopReason: "stop" });
  });
});

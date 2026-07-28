import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { runCli } from "./index.js";

/** Fake streamFn that emits `text` as a sequence of text deltas, then completes. */
function fakeStreamFn(text: string): StreamFn {
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
    const base: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage,
      stopReason: "stop",
      timestamp: 0,
    };

    stream.push({ type: "start", partial: base } satisfies AssistantMessageEvent);
    stream.push({
      type: "text_start",
      contentIndex: 0,
      partial: { ...base, content: [{ type: "text", text: "" }] },
    } satisfies AssistantMessageEvent);

    let acc = "";
    for (const ch of text) {
      acc += ch;
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: ch,
        partial: { ...base, content: [{ type: "text", text: acc }] },
      } satisfies AssistantMessageEvent);
    }

    const final: AssistantMessage = { ...base, content: [{ type: "text", text: acc }] };
    stream.push({ type: "text_end", contentIndex: 0, content: acc, partial: final } satisfies AssistantMessageEvent);
    stream.push({ type: "done", reason: "stop", message: final } satisfies AssistantMessageEvent);

    return stream;
  };
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

describe("runCli", () => {
  it("fails fast with setup guidance when ANTHROPIC_API_KEY is unset", async () => {
    const io = captureOutput();

    const exitCode = await runCli(["hi"], {}, { stdout: io.stdout, stderr: io.stderr });

    expect(exitCode).toBe(1);
    expect(io.err()).toContain("ANTHROPIC_API_KEY");
    expect(io.err()).toContain("export ANTHROPIC_API_KEY=");
    expect(io.out()).toBe("");
  });

  it("streams assistant text deltas to stdout when authenticated", async () => {
    const io = captureOutput();

    const exitCode = await runCli(["hi"], { ANTHROPIC_API_KEY: "sk-ant-test" }, {
      stdout: io.stdout,
      stderr: io.stderr,
      streamFn: fakeStreamFn("hello from mori"),
    });

    expect(exitCode).toBe(0);
    expect(io.out()).toBe("hello from mori\n");
    expect(io.err()).toBe("");
  });

  it("prints usage and fails when no prompt is given", async () => {
    const io = captureOutput();

    const exitCode = await runCli([], { ANTHROPIC_API_KEY: "sk-ant-test" }, {
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(exitCode).toBe(1);
    expect(io.err()).toContain("usage: mori");
  });
});

#!/usr/bin/env node
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { BufferKernel } from "@mori/kernel";
import { createMoriAgent } from "./agent.js";

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  console.error("usage: mori <prompt>");
  process.exit(1);
}

const kernel = new BufferKernel<AgentMessage, AgentEvent>();
const agent = createMoriAgent(kernel);

agent.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await agent.prompt(prompt);
process.stdout.write("\n");

const last = agent.state.messages.at(-1);
if (last?.role === "assistant" && last.stopReason === "error") {
  console.error(`mori: ${last.errorMessage ?? "unknown provider error"}`);
  process.exit(1);
}

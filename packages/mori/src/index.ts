#!/usr/bin/env node
import type { AgentEvent, AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { BufferKernel } from "@mori/kernel";
import { createMoriAgent } from "./agent.js";

const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

export interface RunCliDeps {
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  streamFn?: StreamFn;
}

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: RunCliDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = deps.stderr ?? ((chunk: string) => process.stderr.write(chunk));

  const prompt = argv.join(" ").trim();
  if (!prompt) {
    stderr("usage: mori <prompt>\n");
    return 1;
  }

  if (!env[ANTHROPIC_API_KEY_ENV]) {
    stderr(
      `mori: ${ANTHROPIC_API_KEY_ENV} is not set.\n` +
        `Set it before running mori, e.g.:\n` +
        `  export ${ANTHROPIC_API_KEY_ENV}=sk-ant-...\n`,
    );
    return 1;
  }

  const kernel = new BufferKernel<AgentMessage, AgentEvent>();
  const agent = createMoriAgent(kernel, env, deps.streamFn);

  agent.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      stdout(event.assistantMessageEvent.delta);
    }
  });

  await agent.prompt(prompt);
  stdout("\n");

  const last = agent.state.messages.at(-1);
  if (last?.role === "assistant" && last.stopReason === "error") {
    stderr(`mori: ${last.errorMessage ?? "unknown provider error"}\n`);
    return 1;
  }

  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const exitCode = await runCli(process.argv.slice(2), process.env);
  process.exit(exitCode);
}

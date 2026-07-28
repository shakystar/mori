import { Agent, type AgentEvent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { MemoryKernel } from "@mori/kernel";

export type MoriKernel = MemoryKernel<AgentMessage, AgentEvent>;

const DEFAULT_MODEL = "claude-sonnet-4-6";

export function createMoriAgent(
  kernel: MoriKernel,
  env: NodeJS.ProcessEnv = process.env,
  streamFn?: StreamFn,
): Agent {
  const models = createModels();
  models.setProvider(anthropicProvider());

  const modelId = env.MORI_MODEL ?? DEFAULT_MODEL;
  const model = models.getModel("anthropic", modelId);
  if (!model) throw new Error(`Unknown model: anthropic/${modelId}`);

  const agent = new Agent({
    initialState: {
      systemPrompt: "You are mori, a memory-native coding agent.",
      model,
    },
    transformContext: (messages, signal) => kernel.transformContext(messages, signal),
    streamFn: streamFn ?? models.streamSimple.bind(models),
  });

  agent.subscribe((event) => kernel.observe(event));

  return agent;
}

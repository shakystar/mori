import { Agent, type AgentEvent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { MemoryKernel } from "@mori/kernel";
import { resolveProviderSelection, SUPPORTED_PROVIDER_IDS, unknownProviderMessage } from "./provider-selection.js";

export type MoriKernel = MemoryKernel<AgentMessage, AgentEvent>;

export function createMoriAgent(
  kernel: MoriKernel,
  env: NodeJS.ProcessEnv = process.env,
  streamFn?: StreamFn,
): Agent {
  const models = createModels();
  // anthropicProvider()/openaiProvider() resolve credentials from process.env directly, not
  // from `env`. Callers that pass a custom `env` still pre-check the provider's API key env
  // var against it (see index.ts runCli), but the real turn only succeeds if process.env
  // carries the same key. Both providers are always registered so a model lookup for either
  // supported provider id succeeds regardless of which one is selected below.
  models.setProvider(anthropicProvider());
  models.setProvider(openaiProvider());

  const { providerId, modelId } = resolveProviderSelection(env);
  if (!SUPPORTED_PROVIDER_IDS.includes(providerId)) {
    throw new Error(unknownProviderMessage(providerId));
  }

  const model = models.getModel(providerId, modelId);
  if (!model) {
    throw new Error(
      `mori: 알 수 없는 모델 "${modelId}" (프로바이더 "${providerId}").\n` +
        `사용 가능한 모델: ${models
          .getModels(providerId)
          .map((m) => m.id)
          .join(", ")}\n`,
    );
  }

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

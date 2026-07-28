import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { MemoryKernel } from "@mori/kernel";
import { resolveProviderSelection, SUPPORTED_PROVIDER_IDS, unknownProviderMessage } from "./provider-selection.js";
import { createBashBeforeToolCall, createMoriTools } from "./tools/index.js";

export type MoriKernel = MemoryKernel<AgentMessage, AgentEvent>;

export interface CreateMoriAgentOptions {
  /**
   * Working root shared by every tool: the path guard (read_file/list_dir/grep/edit_file)
   * resolves paths against it, and it becomes the bash tool's child cwd. Defaults to
   * `process.cwd()`.
   */
  root?: string;
  /**
   * Tools to register, in place of the default toolset built from `root`. Pass `[]` to
   * get the pre-toolset single-prompt behavior back (e.g. for regression tests).
   */
  tools?: AgentTool<any>[];
}

export function createMoriAgent(
  kernel: MoriKernel,
  env: NodeJS.ProcessEnv = process.env,
  streamFn?: StreamFn,
  options: CreateMoriAgentOptions = {},
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

  const tools = options.tools ?? createMoriTools(options.root ?? process.cwd(), env);

  const agent = new Agent({
    initialState: {
      systemPrompt: "You are mori, a memory-native coding agent.",
      model,
      tools,
    },
    transformContext: (messages, signal) => kernel.transformContext(messages, signal),
    streamFn: streamFn ?? models.streamSimple.bind(models),
    beforeToolCall: createBashBeforeToolCall(),
    // bash is not a sandbox (arbitrary reads/writes anywhere the host user can reach) and
    // edit_file performs its own read-modify-write cycle; running either concurrently with
    // another tool call risks racing on the same files with no isolation to fall back on.
    // Sequential is the safe default until per-tool concurrency is audited.
    toolExecution: "sequential",
  });

  agent.subscribe((event) => kernel.observe(event));

  return agent;
}

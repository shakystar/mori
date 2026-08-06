import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import type { MemoryKernel } from "@mori/kernel";
import { createMoriModels } from "./model-wiring.js";
import {
  resolveProviderSelection,
  supportedProviderIds,
  unknownProviderMessage,
} from "./provider-selection.js";
import { createBashBeforeToolCall, createMoriTools } from "../tools/index.js";

export { createMoriModels };

/**
 * The kernel seam as mori instantiates it, plus `drain`.
 *
 * `drain` is not on `MemoryKernel` — the seam's `observe` is synchronous, so a
 * kernel that persists anything has to finish that work after `observe` returned,
 * and only the HOST knows when it is about to stop giving it the chance. `mori
 * "…"` exits the process as soon as the turn ends, so without a settle point the
 * last observation of every one-shot run would be lost. Requiring it here rather
 * than widening the replaceable seam keeps that a harness-lifecycle concern.
 */
export interface MoriKernel extends MemoryKernel<AgentMessage, AgentEvent> {
  /** Settle whatever `observe` queued. Resolves when the store has caught up. */
  drain(): Promise<void>;
}

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool<TArgs> erasure for a heterogeneous tool array
  tools?: AgentTool<any>[];
  /**
   * Test seam: the `Models` this agent resolves its model and streaming through, in
   * place of building one via `createMoriModels(env, credentialStore)`. `cli/runtime.ts`'s
   * `prepareAgent` passes its own `models` (real, or the `RunCliDeps.models` test seam)
   * here so the auth gate and the turn always see the same instance — see `cli/types.ts`'s
   * `models` doc for why that identity matters. Unset — the default at every non-test call
   * site — builds a fresh instance exactly as before this seam existed.
   *
   * Setting it leaves the `credentialStore` argument unused by this function: the injected
   * instance already carries whichever store it was built from. Build it from that same
   * store, or the agent resolves auth against one store while its caller believes another.
   */
  models?: MutableModels;
}

export function createMoriAgent(
  kernel: MoriKernel,
  credentialStore: CredentialStore,
  env: NodeJS.ProcessEnv = process.env,
  streamFn?: StreamFn,
  options: CreateMoriAgentOptions = {},
): Agent {
  const models = options.models ?? createMoriModels(env, credentialStore);

  const { providerId, modelId } = resolveProviderSelection(env);
  if (!supportedProviderIds(env).includes(providerId)) {
    throw new Error(unknownProviderMessage(providerId, env));
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

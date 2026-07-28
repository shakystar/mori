import { Agent, type AgentEvent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  createModels,
  defaultProviderAuthContext,
  type AuthContext,
  type CredentialStore,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { MemoryKernel } from "@mori/kernel";
import { hidingOAuth } from "./auth/resolve-credentials.js";
import { resolveProviderSelection, SUPPORTED_PROVIDER_IDS, unknownProviderMessage } from "./provider-selection.js";

export type MoriKernel = MemoryKernel<AgentMessage, AgentEvent>;

/**
 * pi-ai's `anthropicProvider()` bundles Claude Pro/Max subscription OAuth — a flow that
 * makes requests impersonate Claude Code (see #16's investigation). Standing project
 * decision: that path must never carry a real request. Stripping `oauth` here is what
 * makes it safe to wire an arbitrary `CredentialStore` into the real request path below —
 * a stored OAuth credential (however it got there) can now only ever fail auth, never
 * silently authenticate one.
 */
function apiKeyOnlyAnthropicProvider() {
  const provider = anthropicProvider();
  return { ...provider, auth: { apiKey: provider.auth.apiKey } };
}

/** Reads env vars from the injected `env`, not ambient `process.env`. */
function envAuthContext(env: NodeJS.ProcessEnv): AuthContext {
  const base = defaultProviderAuthContext();
  return {
    env: async (name) => {
      const value = env[name];
      return typeof value === "string" && value.trim().length > 0 ? value : undefined;
    },
    fileExists: (path) => base.fileExists(path),
  };
}

/**
 * The single place `credentialStore` becomes the pi-ai auth path. Both the CLI's
 * pre-flight auth gate (index.ts's `runCli`) and the real agent turn (`createMoriAgent`
 * below) call this and get the same answer, because both go through the same
 * Models/provider/store configuration — there is no separate, hand-rolled resolution logic
 * that could drift out of sync with it. Neither provider wired below supports subscription
 * OAuth (anthropic has it stripped, openai never had it), so `hidingOAuth` keeps a stored
 * OAuth credential for either from silently shadowing a valid API key env var.
 */
export function createMoriModels(env: NodeJS.ProcessEnv, credentialStore: CredentialStore): MutableModels {
  const models = createModels({
    credentials: hidingOAuth(credentialStore),
    authContext: envAuthContext(env),
  });
  models.setProvider(apiKeyOnlyAnthropicProvider());
  models.setProvider(openaiProvider());
  return models;
}

export function createMoriAgent(
  kernel: MoriKernel,
  credentialStore: CredentialStore,
  env: NodeJS.ProcessEnv = process.env,
  streamFn?: StreamFn,
): Agent {
  const models = createMoriModels(env, credentialStore);

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

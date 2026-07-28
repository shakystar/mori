#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { AgentEvent, AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { BufferKernel } from "@mori/kernel";
import { createMoriAgent } from "./agent.js";
import { defaultCredentialsPath, FileCredentialStore } from "./auth/credential-store.js";
import { apiKeyEnvVarFor, resolveCredentials } from "./auth/resolve-credentials.js";
import {
  resolveProviderSelection,
  SUPPORTED_PROVIDER_IDS,
  unknownProviderMessage,
} from "./provider-selection.js";

export function unauthenticatedMessage(providerId: string): string {
  const apiKeyEnv = apiKeyEnvVarFor(providerId) ?? "API_KEY";
  return (
    "mori: 인증이 필요합니다.\n" +
    "  mori login          # 권장 — 브라우저로 로그인\n" +
    "또는 API key를 쓰려면:\n" +
    `  export ${apiKeyEnv}=...\n`
  );
}

export function loginNotImplementedMessage(providerId: string): string {
  const apiKeyEnv = apiKeyEnvVarFor(providerId) ?? "API_KEY";
  return (
    "mori: `mori login`은 아직 사용할 수 없습니다.\n" +
    "지금은 API key를 쓰세요:\n" +
    `  export ${apiKeyEnv}=...\n`
  );
}

export interface RunCliDeps {
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  streamFn?: StreamFn;
  credentialStore?: CredentialStore;
}

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: RunCliDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = deps.stderr ?? ((chunk: string) => process.stderr.write(chunk));

  const { providerId } = resolveProviderSelection(env);
  if (!SUPPORTED_PROVIDER_IDS.includes(providerId)) {
    stderr(unknownProviderMessage(providerId));
    return 1;
  }

  if (argv[0] === "login") {
    stderr(loginNotImplementedMessage(providerId));
    return 1;
  }

  const prompt = argv.join(" ").trim();
  if (!prompt) {
    stderr("usage: mori <prompt>\n");
    return 1;
  }

  const credentialStore =
    deps.credentialStore ?? new FileCredentialStore(defaultCredentialsPath(env), stderr);
  const credentials = await resolveCredentials(env, credentialStore, providerId);
  if (!credentials) {
    stderr(unauthenticatedMessage(providerId));
    return 1;
  }

  const kernel = new BufferKernel<AgentMessage, AgentEvent>();
  let agent;
  try {
    agent = createMoriAgent(kernel, env, deps.streamFn);
  } catch (err) {
    // Unknown-model errors from createMoriAgent are already a plain, user-facing message
    // (see agent.ts) — surface it as CLI output, not an uncaught stack trace.
    stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
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

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  const exitCode = await runCli(process.argv.slice(2), process.env);
  process.exit(exitCode);
}

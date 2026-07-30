import { createInterface } from "node:readline/promises";
import type { AuthType, MutableModels } from "@earendil-works/pi-ai";
import { createCliAuthInteraction } from "../auth/cli-interaction.js";
import { defaultCredentialsPath, FileCredentialStore } from "../auth/credential-store.js";
import { OPENAI_OAUTH_PROVIDER_ID } from "../auth/experimental.js";
import { createMoriModels } from "../model-wiring.js";
import {
  experimentalOpenAiOAuthNotice,
  loginFailedMessage,
  loginSuccessMessage,
  logoutFailedMessage,
  logoutSuccessMessage,
} from "./messages.js";
import type { RunCliDeps } from "./types.js";

export interface LoginIO {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

/**
 * `mori login`. The flow itself is pi-ai's, not mori's: `models.login()` runs the
 * provider-owned handler — PKCE, the loopback callback server, device-code polling — and
 * persists whatever credential it returns through the injected `CredentialStore`. mori owns
 * exactly three things here: which auth method to ask the provider for, how prompts and
 * events are rendered to a terminal (`createCliAuthInteraction`, #43), and what is printed
 * afterwards. There is deliberately no hand-rolled OAuth code in this repo.
 */
export async function runLogin(
  providerId: string,
  env: NodeJS.ProcessEnv,
  deps: RunCliDeps,
  io: LoginIO,
): Promise<number> {
  const models = modelsFor(env, deps, io);

  // The auth method is read off the registered provider rather than mapped from a provider
  // id. anthropic is registered with `auth.oauth` stripped (model-wiring.ts, #16), so this
  // resolves to "api_key" for it and there is no branch that could ask pi-ai for an
  // Anthropic subscription-OAuth login — #44's second hard constraint holds structurally.
  const authType: AuthType = models.getProvider(providerId)?.auth.oauth ? "oauth" : "api_key";

  const interaction = createCliAuthInteraction({
    stdout: io.stdout,
    question: deps.question ?? readLine,
    ...(deps.openBrowser ? { openBrowser: deps.openBrowser } : {}),
  });

  try {
    await models.login(providerId, authType, interaction);
  } catch (error) {
    io.stderr(loginFailedMessage(providerId, reasonOf(error)));
    return 1;
  }

  if (providerId === OPENAI_OAUTH_PROVIDER_ID) {
    io.stderr(experimentalOpenAiOAuthNotice());
  }
  io.stdout(loginSuccessMessage(providerId));
  return 0;
}

/** `mori logout` — drops the stored credential for one provider. Never touches the others. */
export async function runLogout(
  providerId: string,
  env: NodeJS.ProcessEnv,
  deps: RunCliDeps,
  io: LoginIO,
): Promise<number> {
  const models = modelsFor(env, deps, io);

  try {
    await models.logout(providerId);
  } catch (error) {
    io.stderr(logoutFailedMessage(providerId, reasonOf(error)));
    return 1;
  }

  io.stdout(logoutSuccessMessage(providerId));
  return 0;
}

function modelsFor(env: NodeJS.ProcessEnv, deps: RunCliDeps, io: LoginIO): MutableModels {
  if (deps.loginModels) return deps.loginModels;
  const credentialStore =
    deps.credentialStore ?? new FileCredentialStore(defaultCredentialsPath(env), io.stderr);
  return createMoriModels(env, credentialStore);
}

/** pi-ai rejects with `ModelsError`, whose message is already user-facing. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Default `question`: one line from stdin. Kept behind `RunCliDeps.question` so every test
 * drives login without a TTY — this is the only place the process's real stdin is touched.
 */
async function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

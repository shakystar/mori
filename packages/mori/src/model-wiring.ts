import {
  createModels,
  defaultProviderAuthContext,
  type AuthContext,
  type CredentialStore,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { experimentalOpenAiOAuthEnabled } from "./auth/experimental.js";
import { hidingOAuth } from "./auth/resolve-credentials.js";

/**
 * pi-ai's `anthropicProvider()` bundles Claude Pro/Max subscription OAuth — a flow that
 * makes requests impersonate Claude Code (see #16's investigation). Standing project
 * decision: that path must never carry a real request. Stripping `oauth` here is what
 * makes it safe to wire an arbitrary `CredentialStore` into the real request path below —
 * a stored OAuth credential (however it got there) can now only ever fail auth, never
 * silently authenticate one.
 *
 * The absent `auth.oauth` is also what makes anthropic un-loginable over OAuth: `mori login`
 * reads the auth method off the registered provider (cli/login.ts), and `createMoriModels`
 * hides stored OAuth credentials for exactly the providers missing this field. Restoring it
 * here would silently undo both, so this is deliberately not a "cleanup" candidate.
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
 * Every provider mori registers, in registration order — the single source of truth for
 * "which providers exist in this environment". `provider-selection.ts` derives the
 * selectable/loginable id list from this same function, so a provider can never be
 * unregistered yet selectable, or vice versa.
 *
 * `openai-codex` (pi-ai's ChatGPT-subscription provider, OAuth-only) is appended *only*
 * when the experimental gate is on. With the gate off it is never constructed, so it
 * cannot surface in a provider list, a model lookup, or a `mori login` target — the
 * default-off hard constraint of #44 holds by construction rather than by filtering it
 * back out at each surface.
 */
export function moriProviders(env: NodeJS.ProcessEnv): readonly Provider[] {
  const providers: Provider[] = [apiKeyOnlyAnthropicProvider(), openaiProvider()];
  if (experimentalOpenAiOAuthEnabled(env)) {
    providers.push(openaiCodexProvider());
  }
  return providers;
}

/** Ids of the providers registered for this environment. See `moriProviders`. */
export function moriProviderIds(env: NodeJS.ProcessEnv): readonly string[] {
  return moriProviders(env).map((provider) => provider.id);
}

/**
 * The single place `credentialStore` becomes the pi-ai auth path. The CLI's pre-flight auth
 * gate (cli/runtime.ts), the real agent turn (`createMoriAgent` in agent.ts), and
 * `mori login`/`logout` (cli/login.ts) all call this and get the same answer, because they
 * go through the same Models/provider/store configuration — there is no separate,
 * hand-rolled resolution logic that could drift out of sync with it.
 *
 * `hidingOAuth` is applied per provider, not globally: a stored OAuth credential is hidden
 * exactly for the providers registered *without* an `auth.oauth` handler, so it can never
 * shadow a valid API key env var on a provider that would reject it (anthropic, openai),
 * while `openai-codex` — whose only auth method is OAuth — reads the credential
 * `mori login` just stored.
 */
export function createMoriModels(env: NodeJS.ProcessEnv, credentialStore: CredentialStore): MutableModels {
  const providers = moriProviders(env);
  const oauthCapableIds = new Set(
    providers.filter((provider) => provider.auth.oauth).map((provider) => provider.id),
  );

  const models = createModels({
    credentials: hidingOAuth(credentialStore, (providerId) => !oauthCapableIds.has(providerId)),
    authContext: envAuthContext(env),
  });
  for (const provider of providers) {
    models.setProvider(provider);
  }
  return models;
}

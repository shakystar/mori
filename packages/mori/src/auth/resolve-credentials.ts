import type { CredentialStore } from "@earendil-works/pi-ai";

/**
 * Provider id → API key env var name, the single place this mapping lives.
 * Verified against the installed @earendil-works/pi-ai@0.82.1's own env-key table
 * (dist/env-api-keys.js, getApiKeyEnvVars) rather than assumed.
 */
export const PROVIDER_API_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

export function apiKeyEnvVarFor(providerId: string): string | undefined {
  return PROVIDER_API_KEY_ENV[providerId];
}

export interface OAuthResolvedCredentials {
  kind: "oauth";
  accessToken: string;
  expiresAt: number;
}

export interface ApiKeyResolvedCredentials {
  kind: "apiKey";
  apiKey: string;
}

export type ResolvedCredentials = OAuthResolvedCredentials | ApiKeyResolvedCredentials;

/**
 * Priority: ① a non-expired OAuth token in `store` for `providerId` ② the provider's API
 * key env var (see `PROVIDER_API_KEY_ENV`) ③ nothing. An expired stored token is treated
 * as absent (falls through to ②) — this only reads whatever a prior `mori login` stored;
 * refreshing it is out of scope, and pi-ai's own resolver has no such fallback (see PR
 * description), so it's implemented here.
 *
 * #16 결정: 구독 OAuth 토큰 직접 사용 금지 — this only *resolves* a stored OAuth token so
 * callers can report auth status; it must never be sent to a provider request. That
 * remains a standing rule, not a placeholder for future wiring.
 *
 * Not the CLI auth gate: `runCli` (index.ts) gates through `createMoriModels(...).checkAuth`
 * (agent.ts) instead, so gate and real request always agree by construction (#42). This
 * stays as a provider-agnostic status query used outside that request path.
 */
export async function resolveCredentials(
  env: NodeJS.ProcessEnv,
  store: CredentialStore,
  providerId: string,
): Promise<ResolvedCredentials | null> {
  const stored = await store.read(providerId);
  if (stored?.type === "oauth" && Date.now() < stored.expires) {
    return { kind: "oauth", accessToken: stored.access, expiresAt: stored.expires };
  }

  const apiKeyEnv = apiKeyEnvVarFor(providerId);
  const apiKey = apiKeyEnv ? env[apiKeyEnv] : undefined;
  if (apiKey) {
    return { kind: "apiKey", apiKey };
  }

  return null;
}

/**
 * Wraps a `CredentialStore` so a stored OAuth credential reads as absent — regardless of
 * expiry — for every provider `shouldHide` selects.
 *
 * Why it exists: pi-ai's auth resolution has no env fallback once *anything* is stored for
 * a provider (once stored, the credential owns that provider; ambient/env is not consulted
 * — see `checkProviderAuth`/`resolveProviderAuth` in the installed `@earendil-works/pi-ai`).
 * So on a provider that cannot use OAuth for a real request, a stored OAuth credential
 * would permanently shadow a valid API key env var.
 *
 * Why it is conditional rather than unconditional: as of #44 that is no longer true of
 * every provider mori registers. `openai-codex` authenticates with OAuth and nothing else,
 * so hiding its credential would make `mori login` succeed and then leave every request
 * unauthenticated. The caller passes the policy — `model-wiring.ts` hides OAuth exactly for
 * the providers whose registered `auth.oauth` is absent, which keeps anthropic hidden
 * (#16's standing decision, enforced by stripping `auth.oauth` there) without hard-coding
 * a provider id here.
 */
export function hidingOAuth(
  store: CredentialStore,
  shouldHide: (providerId: string) => boolean,
): CredentialStore {
  return {
    read: async (providerId) => {
      const credential = await store.read(providerId);
      if (credential?.type === "oauth" && shouldHide(providerId)) return undefined;
      return credential;
    },
    list: () => store.list(),
    modify: (providerId, fn) => store.modify(providerId, fn),
    delete: (providerId) => store.delete(providerId),
  };
}

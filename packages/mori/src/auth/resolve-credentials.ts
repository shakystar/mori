import type { CredentialStore } from "@earendil-works/pi-ai";

const ANTHROPIC_PROVIDER_ID = "anthropic";
const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

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
 * Priority: ① a non-expired OAuth token in `store` ② `env.ANTHROPIC_API_KEY` ③ nothing.
 * An expired stored token is treated as absent (falls through to ②) — this issue only
 * reads whatever a prior `mori login` stored; refreshing it is out of scope, and pi-ai's
 * own resolver has no such fallback (see PR description), so it's implemented here.
 * Never sends the resolved OAuth token to a provider — that wiring is deferred to #16.
 */
export async function resolveCredentials(
  env: NodeJS.ProcessEnv,
  store: CredentialStore,
): Promise<ResolvedCredentials | null> {
  const stored = await store.read(ANTHROPIC_PROVIDER_ID);
  if (stored?.type === "oauth" && Date.now() < stored.expires) {
    return { kind: "oauth", accessToken: stored.access, expiresAt: stored.expires };
  }

  const apiKey = env[ANTHROPIC_API_KEY_ENV];
  if (apiKey) {
    return { kind: "apiKey", apiKey };
  }

  return null;
}

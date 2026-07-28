import { PROVIDER_API_KEY_ENV } from "./auth/resolve-credentials.js";

export const DEFAULT_PROVIDER_ID = "anthropic";
export const DEFAULT_MODEL_ID = "claude-sonnet-4-6";

/** Providers mori knows an API-key env var for — the same set resolveCredentials can serve. */
export const SUPPORTED_PROVIDER_IDS = Object.keys(PROVIDER_API_KEY_ENV);

export interface ProviderSelection {
  providerId: string;
  modelId: string;
}

/**
 * `MORI_MODEL` selects both provider and model. Rule: a value containing "/" is
 * `<providerId>/<modelId>` (e.g. `openai/gpt-5.1`); a bare value has no provider and is
 * read as an anthropic model id — this keeps the pre-existing `MORI_MODEL=claude-sonnet-4-6`
 * form working unchanged, since anthropic is the default provider. Unset falls back to the
 * anthropic default model.
 */
export function resolveProviderSelection(env: NodeJS.ProcessEnv): ProviderSelection {
  const raw = env.MORI_MODEL;
  if (!raw) {
    return { providerId: DEFAULT_PROVIDER_ID, modelId: DEFAULT_MODEL_ID };
  }

  const slash = raw.indexOf("/");
  if (slash === -1) {
    return { providerId: DEFAULT_PROVIDER_ID, modelId: raw };
  }

  return { providerId: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
}

export function unknownProviderMessage(providerId: string): string {
  return (
    `mori: 알 수 없는 프로바이더 "${providerId}".\n` +
    `지원하는 프로바이더: ${SUPPORTED_PROVIDER_IDS.join(", ")}\n`
  );
}

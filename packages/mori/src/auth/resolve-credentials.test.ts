import type { Credential } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { OPENAI_OAUTH_PROVIDER_ID } from "./experimental.js";
import { apiKeyEnvVarFor, hidingOAuth, resolveCredentials } from "./resolve-credentials.js";

const ONE_HOUR_MS = 60 * 60 * 1000;

async function storeWith(providerId: string, credential: Credential): Promise<InMemoryCredentialStore> {
  const store = new InMemoryCredentialStore();
  await store.modify(providerId, async () => credential);
  return store;
}

describe("resolveCredentials", () => {
  it("prefers a non-expired stored OAuth token over ANTHROPIC_API_KEY", async () => {
    const store = await storeWith("anthropic", {
      type: "oauth",
      access: "at-valid",
      refresh: "rt-valid",
      expires: Date.now() + ONE_HOUR_MS,
    });

    const result = await resolveCredentials({ ANTHROPIC_API_KEY: "sk-ant-env" }, store, "anthropic");

    expect(result).toEqual({ kind: "oauth", accessToken: "at-valid", expiresAt: expect.any(Number) });
  });

  it("falls back to ANTHROPIC_API_KEY when the store is empty", async () => {
    const store = new InMemoryCredentialStore();

    const result = await resolveCredentials({ ANTHROPIC_API_KEY: "sk-ant-env" }, store, "anthropic");

    expect(result).toEqual({ kind: "apiKey", apiKey: "sk-ant-env" });
  });

  it("treats an expired stored OAuth token as absent and falls back to ANTHROPIC_API_KEY", async () => {
    const store = await storeWith("anthropic", {
      type: "oauth",
      access: "at-expired",
      refresh: "rt-expired",
      expires: Date.now() - ONE_HOUR_MS,
    });

    const result = await resolveCredentials({ ANTHROPIC_API_KEY: "sk-ant-env" }, store, "anthropic");

    expect(result).toEqual({ kind: "apiKey", apiKey: "sk-ant-env" });
  });

  it("returns null when neither a stored token nor ANTHROPIC_API_KEY is available", async () => {
    const store = new InMemoryCredentialStore();

    const result = await resolveCredentials({}, store, "anthropic");

    expect(result).toBeNull();
  });

  it("returns null for an expired stored token with no ANTHROPIC_API_KEY fallback", async () => {
    const store = await storeWith("anthropic", {
      type: "oauth",
      access: "at-expired",
      refresh: "rt-expired",
      expires: Date.now() - ONE_HOUR_MS,
    });

    const result = await resolveCredentials({}, store, "anthropic");

    expect(result).toBeNull();
  });

  it("resolves an OpenAI API key from OPENAI_API_KEY, independent of the anthropic store entry", async () => {
    const store = await storeWith("anthropic", {
      type: "oauth",
      access: "at-valid",
      refresh: "rt-valid",
      expires: Date.now() + ONE_HOUR_MS,
    });

    const result = await resolveCredentials({ OPENAI_API_KEY: "sk-oai-env" }, store, "openai");

    expect(result).toEqual({ kind: "apiKey", apiKey: "sk-oai-env" });
  });

  it("prefers a non-expired stored OAuth token over OPENAI_API_KEY", async () => {
    const store = await storeWith("openai", {
      type: "oauth",
      access: "at-valid",
      refresh: "rt-valid",
      expires: Date.now() + ONE_HOUR_MS,
    });

    const result = await resolveCredentials({ OPENAI_API_KEY: "sk-oai-env" }, store, "openai");

    expect(result).toEqual({ kind: "oauth", accessToken: "at-valid", expiresAt: expect.any(Number) });
  });

  it("returns null for a provider with no known API key env var and nothing stored", async () => {
    const store = new InMemoryCredentialStore();

    const result = await resolveCredentials({}, store, "unknown-provider");

    expect(result).toBeNull();
  });
});

describe("apiKeyEnvVarFor", () => {
  it("maps anthropic and openai to their respective API key env vars", () => {
    expect(apiKeyEnvVarFor("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(apiKeyEnvVarFor("openai")).toBe("OPENAI_API_KEY");
  });

  it("returns undefined for an unknown provider", () => {
    expect(apiKeyEnvVarFor("unknown-provider")).toBeUndefined();
  });

  it("has no entry for the OAuth-only openai-codex provider", () => {
    // `openai-codex` authenticates with OAuth and nothing else, so there is no API key env
    // var to name for it — callers must branch on the undefined rather than invent one
    // (see cli/messages.ts's unauthenticatedMessage).
    expect(apiKeyEnvVarFor(OPENAI_OAUTH_PROVIDER_ID)).toBeUndefined();
  });
});

describe("hidingOAuth", () => {
  const oauthCredential: Credential = {
    type: "oauth",
    access: "at",
    refresh: "rt",
    expires: Date.now() + ONE_HOUR_MS,
  };

  it("hides a stored OAuth credential for the providers the policy selects", async () => {
    const store = await storeWith("anthropic", oauthCredential);

    const hidden = hidingOAuth(store, (providerId) => providerId === "anthropic");

    expect(await hidden.read("anthropic")).toBeUndefined();
  });

  it("passes a stored OAuth credential through for providers the policy leaves alone", async () => {
    // #44: openai-codex has no auth method other than OAuth, so hiding its credential would
    // make `mori login` succeed and every subsequent request fail as unauthenticated.
    const store = await storeWith(OPENAI_OAUTH_PROVIDER_ID, oauthCredential);

    const hidden = hidingOAuth(store, (providerId) => providerId !== OPENAI_OAUTH_PROVIDER_ID);

    expect(await hidden.read(OPENAI_OAUTH_PROVIDER_ID)).toEqual(oauthCredential);
  });

  it("never hides an api_key credential", async () => {
    const store = await storeWith("anthropic", { type: "api_key", key: "sk-ant-stored" });

    const hidden = hidingOAuth(store, () => true);

    expect(await hidden.read("anthropic")).toEqual({ type: "api_key", key: "sk-ant-stored" });
  });

  it("writes and deletes straight through, so login and logout still reach the real store", async () => {
    const store = new InMemoryCredentialStore();
    const hidden = hidingOAuth(store, () => true);

    await hidden.modify("anthropic", async () => oauthCredential);
    expect(await store.read("anthropic")).toEqual(oauthCredential);

    await hidden.delete("anthropic");
    expect(await store.read("anthropic")).toBeUndefined();
  });
});

import type { Credential } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { resolveCredentials } from "./resolve-credentials.js";

const ONE_HOUR_MS = 60 * 60 * 1000;

async function storeWith(credential: Credential): Promise<InMemoryCredentialStore> {
  const store = new InMemoryCredentialStore();
  await store.modify("anthropic", async () => credential);
  return store;
}

describe("resolveCredentials", () => {
  it("prefers a non-expired stored OAuth token over ANTHROPIC_API_KEY", async () => {
    const store = await storeWith({
      type: "oauth",
      access: "at-valid",
      refresh: "rt-valid",
      expires: Date.now() + ONE_HOUR_MS,
    });

    const result = await resolveCredentials({ ANTHROPIC_API_KEY: "sk-ant-env" }, store);

    expect(result).toEqual({ kind: "oauth", accessToken: "at-valid", expiresAt: expect.any(Number) });
  });

  it("falls back to ANTHROPIC_API_KEY when the store is empty", async () => {
    const store = new InMemoryCredentialStore();

    const result = await resolveCredentials({ ANTHROPIC_API_KEY: "sk-ant-env" }, store);

    expect(result).toEqual({ kind: "apiKey", apiKey: "sk-ant-env" });
  });

  it("treats an expired stored OAuth token as absent and falls back to ANTHROPIC_API_KEY", async () => {
    const store = await storeWith({
      type: "oauth",
      access: "at-expired",
      refresh: "rt-expired",
      expires: Date.now() - ONE_HOUR_MS,
    });

    const result = await resolveCredentials({ ANTHROPIC_API_KEY: "sk-ant-env" }, store);

    expect(result).toEqual({ kind: "apiKey", apiKey: "sk-ant-env" });
  });

  it("returns null when neither a stored token nor ANTHROPIC_API_KEY is available", async () => {
    const store = new InMemoryCredentialStore();

    const result = await resolveCredentials({}, store);

    expect(result).toBeNull();
  });

  it("returns null for an expired stored token with no ANTHROPIC_API_KEY fallback", async () => {
    const store = await storeWith({
      type: "oauth",
      access: "at-expired",
      refresh: "rt-expired",
      expires: Date.now() - ONE_HOUR_MS,
    });

    const result = await resolveCredentials({}, store);

    expect(result).toBeNull();
  });
});

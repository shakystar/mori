import type { Credential } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createMoriModels } from "./agent.js";

const ONE_HOUR_MS = 60 * 60 * 1000;

async function storeWith(credential: Credential): Promise<InMemoryCredentialStore> {
  const store = new InMemoryCredentialStore();
  await store.modify("anthropic", async () => credential);
  return store;
}

describe("createMoriModels", () => {
  it("agrees between checkAuth (the CLI gate) and getAuth (the real request path) in every case", async () => {
    // Regression test for #42: before this issue, the CLI's auth gate and the real
    // provider request read credentials independently (the gate consulted a
    // CredentialStore; the real request read process.env directly), so they could
    // disagree — most notably, a stored OAuth token satisfied the gate but the real
    // request never saw the credential store at all. Both now come from the same
    // `Models` instance (checkAuth/getAuth resolve auth via the identical
    // provider+store+authContext config), so they cannot diverge by construction.
    const cases: Array<{ name: string; env: NodeJS.ProcessEnv; credential?: Credential; expectAuthenticated: boolean }> = [
      {
        name: "non-expired OAuth alone, no API key env",
        env: {},
        credential: { type: "oauth", access: "at-valid", refresh: "rt-valid", expires: Date.now() + ONE_HOUR_MS },
        expectAuthenticated: false, // #16: subscription OAuth is never wired into a real request
      },
      {
        name: "expired OAuth, valid API key env",
        env: { ANTHROPIC_API_KEY: "sk-ant-test" },
        credential: { type: "oauth", access: "at-expired", refresh: "rt-expired", expires: Date.now() - ONE_HOUR_MS },
        expectAuthenticated: true,
      },
      {
        name: "nothing stored, valid API key env",
        env: { ANTHROPIC_API_KEY: "sk-ant-test" },
        expectAuthenticated: true,
      },
      {
        name: "nothing stored, no API key env",
        env: {},
        expectAuthenticated: false,
      },
    ];

    for (const { env, credential, expectAuthenticated } of cases) {
      const store = credential ? await storeWith(credential) : new InMemoryCredentialStore();
      const models = createMoriModels(env, store);

      const gate = await models.checkAuth("anthropic");
      const real = await models.getAuth("anthropic");

      expect(Boolean(gate)).toBe(expectAuthenticated);
      expect(Boolean(real)).toBe(expectAuthenticated);
    }
  });

  it("resolves the API key from the injected env, not ambient process.env", async () => {
    const store = new InMemoryCredentialStore();
    const models = createMoriModels({ ANTHROPIC_API_KEY: "sk-ant-injected" }, store);

    const auth = await models.getAuth("anthropic");

    expect(auth?.auth.apiKey).toBe("sk-ant-injected");
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Credential,
  OAuthCredential,
  Provider,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { EXPERIMENTAL_OPENAI_OAUTH_ENV, OPENAI_OAUTH_PROVIDER_ID } from "./auth/experimental.js";
import { runCli, unauthenticatedMessage } from "./index.js";
import { createMoriModels } from "./model-wiring.js";

const ONE_HOUR_MS = 60 * 60 * 1000;
const GATE_ON = { [EXPERIMENTAL_OPENAI_OAUTH_ENV]: "1" } as const;

/** An InMemoryCredentialStore pre-seeded with an "anthropic" credential. */
async function storeWith(credential: Credential): Promise<InMemoryCredentialStore> {
  const store = new InMemoryCredentialStore();
  // `modify` is the only write path (see pi-ai's CredentialStore contract).
  await store.modify("anthropic", async () => credential);
  return store;
}

/** Fake streamFn that emits `text` as a sequence of text deltas, then completes. */
function fakeStreamFn(text: string): StreamFn {
  return (model) => {
    const stream = createAssistantMessageEventStream();
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const base: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage,
      stopReason: "stop",
      timestamp: 0,
    };

    stream.push({ type: "start", partial: base } satisfies AssistantMessageEvent);
    stream.push({
      type: "text_start",
      contentIndex: 0,
      partial: { ...base, content: [{ type: "text", text: "" }] },
    } satisfies AssistantMessageEvent);

    let acc = "";
    for (const ch of text) {
      acc += ch;
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: ch,
        partial: { ...base, content: [{ type: "text", text: acc }] },
      } satisfies AssistantMessageEvent);
    }

    const final: AssistantMessage = { ...base, content: [{ type: "text", text: acc }] };
    stream.push({ type: "text_end", contentIndex: 0, content: acc, partial: final } satisfies AssistantMessageEvent);
    stream.push({ type: "done", reason: "stop", message: final } satisfies AssistantMessageEvent);

    return stream;
  };
}

function oauthCredential(): OAuthCredential {
  return { type: "oauth", access: "at-codex", refresh: "rt-codex", expires: Date.now() + ONE_HOUR_MS };
}

/**
 * Stands in for pi-ai's `openai-codex` provider at the one boundary a test cannot cross: an
 * `OAuthAuth.login` that would otherwise open a browser and talk to chatgpt.com. Everything
 * on mori's side of that boundary — the gate, the auth-type choice, credential persistence,
 * the `hidingOAuth` policy — stays real.
 */
function fakeOAuthProvider(id: string, credential: OAuthCredential): Provider {
  return {
    id,
    name: `fake ${id}`,
    auth: {
      oauth: {
        name: "fake subscription OAuth",
        login: async (interaction) => {
          interaction.notify({ type: "auth_url", url: "https://example.invalid/authorize" });
          return credential;
        },
        refresh: async (current) => current,
        toAuth: async (current) => ({ apiKey: current.access }),
      },
    },
    getModels: () => [],
    stream: () => {
      throw new Error("fake provider: the login flow never streams");
    },
    streamSimple: () => {
      throw new Error("fake provider: the login flow never streams");
    },
  };
}

function captureOutput() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: (chunk: string) => out.push(chunk),
    stderr: (chunk: string) => err.push(chunk),
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

describe("runCli", () => {
  it("fails fast with OAuth-first setup guidance when no credentials are available", async () => {
    const io = captureOutput();

    const exitCode = await runCli(["hi"], {}, {
      stdout: io.stdout,
      stderr: io.stderr,
      credentialStore: new InMemoryCredentialStore(),
    });

    expect(exitCode).toBe(1);
    expect(io.err()).toContain("mori login");
    expect(io.err()).toContain("export ANTHROPIC_API_KEY=");
    expect(io.out()).toBe("");
  });

  it("streams assistant text deltas to stdout when ANTHROPIC_API_KEY is set", async () => {
    const io = captureOutput();

    const exitCode = await runCli(["hi"], { ANTHROPIC_API_KEY: "sk-ant-test" }, {
      stdout: io.stdout,
      stderr: io.stderr,
      streamFn: fakeStreamFn("hello from mori"),
      credentialStore: new InMemoryCredentialStore(),
    });

    expect(exitCode).toBe(0);
    expect(io.out()).toBe("hello from mori\n");
    expect(io.err()).toBe("");
  });

  it("does not authenticate from a stored OAuth token alone (#16: subscription OAuth never reaches a real request)", async () => {
    // Regression test for #42: this scenario used to report "authenticated" (the gate
    // treated a non-expired stored OAuth token as sufficient) while the real turn — which
    // ignored the credential store entirely and read process.env directly — would in fact
    // fail. Now that the gate and the real turn share the same Models/credentialStore
    // configuration (see agent.ts's createMoriModels), and that configuration never wires
    // Anthropic's built-in subscription-OAuth capability (standing #16 decision), both
    // consistently report "unauthenticated" instead of diverging.
    const io = captureOutput();
    const store = await storeWith({
      type: "oauth",
      access: "at-valid",
      refresh: "rt-valid",
      expires: Date.now() + ONE_HOUR_MS,
    });

    const exitCode = await runCli(["hi"], {}, {
      stdout: io.stdout,
      stderr: io.stderr,
      streamFn: fakeStreamFn("hello from mori"),
      credentialStore: store,
    });

    expect(exitCode).toBe(1);
    expect(io.err()).toContain("mori login");
    expect(io.err()).toContain("export ANTHROPIC_API_KEY=");
    expect(io.out()).toBe("");
  });

  it("falls back to ANTHROPIC_API_KEY even when the stored OAuth token has not expired", async () => {
    // Regression test (#42 review): a non-expired stored OAuth token must not shadow a
    // valid API key env var now that anthropic's wiring never accepts OAuth as a real
    // request credential (see agent.ts's hidingOAuth).
    const io = captureOutput();
    const store = await storeWith({
      type: "oauth",
      access: "at-valid",
      refresh: "rt-valid",
      expires: Date.now() + ONE_HOUR_MS,
    });

    const exitCode = await runCli(["hi"], { ANTHROPIC_API_KEY: "sk-ant-test" }, {
      stdout: io.stdout,
      stderr: io.stderr,
      streamFn: fakeStreamFn("hello from mori"),
      credentialStore: store,
    });

    expect(exitCode).toBe(0);
    expect(io.out()).toBe("hello from mori\n");
    expect(io.err()).toBe("");
  });

  it("falls back to ANTHROPIC_API_KEY when the stored OAuth token is expired", async () => {
    const io = captureOutput();
    const store = await storeWith({
      type: "oauth",
      access: "at-expired",
      refresh: "rt-expired",
      expires: Date.now() - ONE_HOUR_MS,
    });

    const exitCode = await runCli(["hi"], { ANTHROPIC_API_KEY: "sk-ant-test" }, {
      stdout: io.stdout,
      stderr: io.stderr,
      streamFn: fakeStreamFn("hello from mori"),
      credentialStore: store,
    });

    expect(exitCode).toBe(0);
    expect(io.out()).toBe("hello from mori\n");
  });

  it("prints usage and fails when no prompt is given", async () => {
    const io = captureOutput();

    const exitCode = await runCli([], { ANTHROPIC_API_KEY: "sk-ant-test" }, {
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(exitCode).toBe(1);
    expect(io.err()).toContain("usage: mori");
  });

  it("names the target provider's own API key env var in the unauthenticated message", () => {
    expect(unauthenticatedMessage("anthropic")).toContain("ANTHROPIC_API_KEY");
    expect(unauthenticatedMessage("anthropic")).not.toContain("OPENAI_API_KEY");

    expect(unauthenticatedMessage("openai")).toContain("OPENAI_API_KEY");
    expect(unauthenticatedMessage("openai")).not.toContain("ANTHROPIC_API_KEY");
  });

  it("points an OAuth-only provider at `mori login` instead of inventing an API key env var", () => {
    // Regression guard for #44's providerId trap: openai-codex has no API key auth at all,
    // and the message used to fall back to a made-up "API_KEY" for any unmapped provider.
    const message = unauthenticatedMessage(OPENAI_OAUTH_PROVIDER_ID);

    expect(message).toContain(`mori login ${OPENAI_OAUTH_PROVIDER_ID}`);
    expect(message).not.toContain("API_KEY");
    expect(message).not.toContain("export ");
  });

  it("streams from the openai provider when MORI_MODEL selects it and OPENAI_API_KEY is set", async () => {
    const io = captureOutput();

    const exitCode = await runCli(
      ["hi"],
      { MORI_MODEL: "openai/gpt-5.4", OPENAI_API_KEY: "sk-oai-test" },
      {
        stdout: io.stdout,
        stderr: io.stderr,
        streamFn: fakeStreamFn("hello from gpt"),
        credentialStore: new InMemoryCredentialStore(),
      },
    );

    expect(exitCode).toBe(0);
    expect(io.out()).toBe("hello from gpt\n");
    expect(io.err()).toBe("");
  });

  it("fails with OpenAI-specific guidance when MORI_MODEL selects openai but OPENAI_API_KEY is unset", async () => {
    const io = captureOutput();

    const exitCode = await runCli(["hi"], { MORI_MODEL: "openai/gpt-5.4" }, {
      stdout: io.stdout,
      stderr: io.stderr,
      credentialStore: new InMemoryCredentialStore(),
    });

    expect(exitCode).toBe(1);
    expect(io.err()).toContain("OPENAI_API_KEY");
    expect(io.err()).not.toContain("ANTHROPIC_API_KEY");
  });

  it("ends with a supported-provider list, not a stack trace, for an unknown provider", async () => {
    const io = captureOutput();

    const exitCode = await runCli(["hi"], { MORI_MODEL: "bogus/whatever" }, {
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(exitCode).toBe(1);
    expect(io.err()).toContain("bogus");
    expect(io.err()).toContain("anthropic");
    expect(io.err()).toContain("openai");
    expect(io.err()).not.toContain("at ");
    expect(io.out()).toBe("");
  });

  it("ends with an available-models list, not a stack trace, for an unknown model on a known provider", async () => {
    const io = captureOutput();

    const exitCode = await runCli(["hi"], { MORI_MODEL: "anthropic/not-a-real-model", ANTHROPIC_API_KEY: "sk-ant-test" }, {
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(exitCode).toBe(1);
    expect(io.err()).toContain("not-a-real-model");
    expect(io.err()).not.toContain("    at ");
    expect(io.out()).toBe("");
  });

  describe("mori login / mori logout", () => {
    it("stores an API key for anthropic and never starts an OAuth flow, even with the gate on", async () => {
      // #44 hard constraint 2 (#35 decision 3): Anthropic subscription OAuth is excluded
      // outright — not even behind the experimental flag. `runLogin` picks its auth type
      // from the registered provider, and anthropic is registered without `auth.oauth`
      // (model-wiring.ts), so the only thing `mori login anthropic` can do is prompt for a
      // key. Turning the gate on must not change that.
      const io = captureOutput();
      const store = new InMemoryCredentialStore();
      const asked: string[] = [];

      const exitCode = await runCli(["login"], { ...GATE_ON }, {
        stdout: io.stdout,
        stderr: io.stderr,
        credentialStore: store,
        question: async (prompt) => {
          asked.push(prompt);
          return "sk-ant-typed";
        },
      });

      expect(exitCode).toBe(0);
      expect(asked.join("\n")).toContain("Anthropic API key");
      expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-ant-typed" });
      expect(io.out()).toContain("로그인 완료");
      expect(io.err()).toBe("");
    });

    it("reports a failed login as a message and a non-zero exit, not a stack trace", async () => {
      const io = captureOutput();

      const exitCode = await runCli(["login"], {}, {
        stdout: io.stdout,
        stderr: io.stderr,
        credentialStore: new InMemoryCredentialStore(),
        question: async () => {
          throw new Error("입력이 취소되었습니다");
        },
      });

      expect(exitCode).toBe(1);
      expect(io.err()).toContain("로그인에 실패");
      expect(io.err()).toContain("입력이 취소되었습니다");
      expect(io.err()).not.toContain("    at ");
    });

    it("`mori logout` removes the stored credential for its provider", async () => {
      const io = captureOutput();
      const store = await storeWith({ type: "api_key", key: "sk-ant-stored" });

      const exitCode = await runCli(["logout"], {}, {
        stdout: io.stdout,
        stderr: io.stderr,
        credentialStore: store,
      });

      expect(exitCode).toBe(0);
      expect(await store.read("anthropic")).toBeUndefined();
      expect(io.out()).toContain("로그아웃 완료");
    });

    describe("with the experimental OpenAI OAuth gate off (the default)", () => {
      it("refuses `mori login openai-codex` and does not list it among supported providers", async () => {
        // The single most important test in #44: with no configuration, this route must be
        // indistinguishable from a provider that does not exist.
        const io = captureOutput();

        const exitCode = await runCli(["login", OPENAI_OAUTH_PROVIDER_ID], {}, {
          stdout: io.stdout,
          stderr: io.stderr,
          credentialStore: new InMemoryCredentialStore(),
        });

        expect(exitCode).toBe(1);
        expect(io.err()).toContain("알 수 없는 프로바이더");
        expect(io.err()).toContain("지원하는 프로바이더: anthropic, openai\n");
        expect(io.out()).toBe("");
      });

      it("refuses to select openai-codex as a model provider", async () => {
        const io = captureOutput();

        const exitCode = await runCli(["hi"], { MORI_MODEL: `${OPENAI_OAUTH_PROVIDER_ID}/gpt-5.1-codex` }, {
          stdout: io.stdout,
          stderr: io.stderr,
          credentialStore: new InMemoryCredentialStore(),
        });

        expect(exitCode).toBe(1);
        expect(io.err()).toContain("알 수 없는 프로바이더");
        expect(io.out()).toBe("");
      });

      it("keeps `mori logout openai-codex` from touching a credential stored under that id", async () => {
        // A gated-off provider is not addressable at all — not even to delete something.
        const io = captureOutput();
        const store = new InMemoryCredentialStore();
        await store.modify(OPENAI_OAUTH_PROVIDER_ID, async () => oauthCredential());

        const exitCode = await runCli(["logout", OPENAI_OAUTH_PROVIDER_ID], {}, {
          stdout: io.stdout,
          stderr: io.stderr,
          credentialStore: store,
        });

        expect(exitCode).toBe(1);
        expect(await store.read(OPENAI_OAUTH_PROVIDER_ID)).toBeDefined();
      });
    });

    describe("with the experimental OpenAI OAuth gate on", () => {
      it("logs in through the provider's own OAuth handler, warns about the risk, and stores the token", async () => {
        const io = captureOutput();
        const credential = oauthCredential();
        const store = new InMemoryCredentialStore();

        // Real `Models` wiring (so credential persistence and the per-provider `hidingOAuth`
        // policy are the production ones); only pi-ai's provider boundary is faked, which is
        // what keeps this test off the network and out of a browser.
        const models = createMoriModels({ ...GATE_ON }, store);
        models.setProvider(fakeOAuthProvider(OPENAI_OAUTH_PROVIDER_ID, credential));

        const exitCode = await runCli(["login", OPENAI_OAUTH_PROVIDER_ID], { ...GATE_ON }, {
          stdout: io.stdout,
          stderr: io.stderr,
          loginModels: models,
        });

        expect(exitCode).toBe(0);
        expect(io.out()).toContain("로그인 완료");
        // The route must announce itself as unofficial *and* name the account risk.
        expect(io.err()).toContain("비공식·실험적");
        expect(io.err()).toContain("정지될 수 있으며");
        expect(await store.read(OPENAI_OAUTH_PROVIDER_ID)).toEqual(credential);
      });

      it("leaves the freshly stored OAuth token usable, instead of hiding it from auth", async () => {
        // Regression test for the trap the owner flagged on this issue: `hidingOAuth` used
        // to hide stored OAuth for every provider, which would make login succeed and every
        // request afterwards report "unauthenticated" with no visible cause.
        const store = new InMemoryCredentialStore();
        const models = createMoriModels({ ...GATE_ON }, store);
        models.setProvider(fakeOAuthProvider(OPENAI_OAUTH_PROVIDER_ID, oauthCredential()));

        await runCli(["login", OPENAI_OAUTH_PROVIDER_ID], { ...GATE_ON }, {
          stdout: () => {},
          stderr: () => {},
          loginModels: models,
        });

        expect(await models.checkAuth(OPENAI_OAUTH_PROVIDER_ID)).toBeDefined();
        expect((await models.getAuth(OPENAI_OAUTH_PROVIDER_ID))?.auth.apiKey).toBe("at-codex");
      });
    });
  });

  describe("with a real, on-disk credential store", () => {
    let configDir: string;

    afterEach(() => {
      if (configDir) rmSync(configDir, { recursive: true, force: true });
    });

    it("doesn't crash on a corrupt credentials.json and falls back to ANTHROPIC_API_KEY", async () => {
      configDir = mkdtempSync(join(tmpdir(), "mori-xdg-"));
      const credentialsDir = join(configDir, "mori");
      mkdirSync(credentialsDir, { recursive: true });
      writeFileSync(join(credentialsDir, "credentials.json"), "{ not valid json", "utf8");

      const io = captureOutput();
      const exitCode = await runCli(
        ["hi"],
        { XDG_CONFIG_HOME: configDir, ANTHROPIC_API_KEY: "sk-ant-test" },
        { stdout: io.stdout, stderr: io.stderr, streamFn: fakeStreamFn("hello from mori") },
      );

      expect(exitCode).toBe(0);
      expect(io.out()).toBe("hello from mori\n");
      expect(io.err()).toContain("invalid JSON");
    });
  });
});

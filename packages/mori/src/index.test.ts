import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, AssistantMessageEvent, Credential } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, unauthenticatedMessage } from "./index.js";

const ONE_HOUR_MS = 60 * 60 * 1000;

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
    stream.push({
      type: "text_end",
      contentIndex: 0,
      content: acc,
      partial: final,
    } satisfies AssistantMessageEvent);
    stream.push({ type: "done", reason: "stop", message: final } satisfies AssistantMessageEvent);

    return stream;
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

    const exitCode = await runCli(
      ["hi"],
      {},
      {
        stdout: io.stdout,
        stderr: io.stderr,
        credentialStore: new InMemoryCredentialStore(),
      },
    );

    expect(exitCode).toBe(1);
    expect(io.err()).toContain("mori login");
    expect(io.err()).toContain("export ANTHROPIC_API_KEY=");
    expect(io.out()).toBe("");
  });

  it("streams assistant text deltas to stdout when ANTHROPIC_API_KEY is set", async () => {
    const io = captureOutput();

    const exitCode = await runCli(
      ["hi"],
      { ANTHROPIC_API_KEY: "sk-ant-test" },
      {
        stdout: io.stdout,
        stderr: io.stderr,
        streamFn: fakeStreamFn("hello from mori"),
        credentialStore: new InMemoryCredentialStore(),
      },
    );

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

    const exitCode = await runCli(
      ["hi"],
      {},
      {
        stdout: io.stdout,
        stderr: io.stderr,
        streamFn: fakeStreamFn("hello from mori"),
        credentialStore: store,
      },
    );

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

    const exitCode = await runCli(
      ["hi"],
      { ANTHROPIC_API_KEY: "sk-ant-test" },
      {
        stdout: io.stdout,
        stderr: io.stderr,
        streamFn: fakeStreamFn("hello from mori"),
        credentialStore: store,
      },
    );

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

    const exitCode = await runCli(
      ["hi"],
      { ANTHROPIC_API_KEY: "sk-ant-test" },
      {
        stdout: io.stdout,
        stderr: io.stderr,
        streamFn: fakeStreamFn("hello from mori"),
        credentialStore: store,
      },
    );

    expect(exitCode).toBe(0);
    expect(io.out()).toBe("hello from mori\n");
  });

  it("prints usage and fails when no prompt is given", async () => {
    const io = captureOutput();

    const exitCode = await runCli(
      [],
      { ANTHROPIC_API_KEY: "sk-ant-test" },
      {
        stdout: io.stdout,
        stderr: io.stderr,
      },
    );

    expect(exitCode).toBe(1);
    expect(io.err()).toContain("usage: mori");
  });

  it("`mori login` reports it isn't implemented yet and points to the API key fallback", async () => {
    const io = captureOutput();

    const exitCode = await runCli(["login"], {}, { stdout: io.stdout, stderr: io.stderr });

    expect(exitCode).toBe(1);
    expect(io.err()).toContain("mori login");
    expect(io.err()).toContain("ANTHROPIC_API_KEY");
    expect(io.out()).toBe("");
  });

  it("names the target provider's own API key env var in the unauthenticated message", () => {
    expect(unauthenticatedMessage("anthropic")).toContain("ANTHROPIC_API_KEY");
    expect(unauthenticatedMessage("anthropic")).not.toContain("OPENAI_API_KEY");

    expect(unauthenticatedMessage("openai")).toContain("OPENAI_API_KEY");
    expect(unauthenticatedMessage("openai")).not.toContain("ANTHROPIC_API_KEY");
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

    const exitCode = await runCli(
      ["hi"],
      { MORI_MODEL: "openai/gpt-5.4" },
      {
        stdout: io.stdout,
        stderr: io.stderr,
        credentialStore: new InMemoryCredentialStore(),
      },
    );

    expect(exitCode).toBe(1);
    expect(io.err()).toContain("OPENAI_API_KEY");
    expect(io.err()).not.toContain("ANTHROPIC_API_KEY");
  });

  it("ends with a supported-provider list, not a stack trace, for an unknown provider", async () => {
    const io = captureOutput();

    const exitCode = await runCli(
      ["hi"],
      { MORI_MODEL: "bogus/whatever" },
      {
        stdout: io.stdout,
        stderr: io.stderr,
      },
    );

    expect(exitCode).toBe(1);
    expect(io.err()).toContain("bogus");
    expect(io.err()).toContain("anthropic");
    expect(io.err()).toContain("openai");
    expect(io.err()).not.toContain("at ");
    expect(io.out()).toBe("");
  });

  it("ends with an available-models list, not a stack trace, for an unknown model on a known provider", async () => {
    const io = captureOutput();

    const exitCode = await runCli(
      ["hi"],
      { MORI_MODEL: "anthropic/not-a-real-model", ANTHROPIC_API_KEY: "sk-ant-test" },
      {
        stdout: io.stdout,
        stderr: io.stderr,
      },
    );

    expect(exitCode).toBe(1);
    expect(io.err()).toContain("not-a-real-model");
    expect(io.err()).not.toContain("    at ");
    expect(io.out()).toBe("");
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

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultCredentialsPath, FileCredentialStore } from "./credential-store.js";

describe("defaultCredentialsPath", () => {
  it("uses $XDG_CONFIG_HOME/mori/credentials.json when set", () => {
    const path = defaultCredentialsPath({ XDG_CONFIG_HOME: "/tmp/xdg" });
    expect(path).toBe(join("/tmp/xdg", "mori", "credentials.json"));
  });

  it("falls back to ~/.config/mori/credentials.json when unset", () => {
    const path = defaultCredentialsPath({});
    expect(path).toMatch(/[/\\]\.config[/\\]mori[/\\]credentials\.json$/);
  });
});

describe("FileCredentialStore", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined and warns nothing when the file doesn't exist yet", async () => {
    dir = mkdtempSync(join(tmpdir(), "mori-creds-"));
    const warnings: string[] = [];
    const store = new FileCredentialStore(join(dir, "credentials.json"), (m) => warnings.push(m));

    const credential = await store.read("anthropic");

    expect(credential).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("treats corrupt JSON as no stored credentials and warns exactly once", async () => {
    dir = mkdtempSync(join(tmpdir(), "mori-creds-"));
    const path = join(dir, "credentials.json");
    writeFileSync(path, "{ not valid json", "utf8");
    const warnings: string[] = [];
    const store = new FileCredentialStore(path, (m) => warnings.push(m));

    const credential = await store.read("anthropic");

    expect(credential).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("invalid JSON");
  });

  it("round-trips a credential through modify() and read()", async () => {
    dir = mkdtempSync(join(tmpdir(), "mori-creds-"));
    const store = new FileCredentialStore(join(dir, "credentials.json"));

    await store.modify("anthropic", async () => ({ type: "api_key", key: "sk-ant-stored" }));
    const credential = await store.read("anthropic");

    expect(credential).toEqual({ type: "api_key", key: "sk-ant-stored" });
  });

  it("deletes a stored credential", async () => {
    dir = mkdtempSync(join(tmpdir(), "mori-creds-"));
    const store = new FileCredentialStore(join(dir, "credentials.json"));
    await store.modify("anthropic", async () => ({ type: "api_key", key: "sk-ant-stored" }));

    await store.delete("anthropic");

    expect(await store.read("anthropic")).toBeUndefined();
  });

  it("writes the credentials file with 0600 permissions and the directory with 0700", async () => {
    dir = mkdtempSync(join(tmpdir(), "mori-creds-"));
    const nestedDir = join(dir, "nested");
    const path = join(nestedDir, "credentials.json");
    const store = new FileCredentialStore(path);

    await store.modify("anthropic", async () => ({ type: "api_key", key: "sk-ant-stored" }));

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(nestedDir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      anthropic: { type: "api_key", key: "sk-ant-stored" },
    });
  });
});

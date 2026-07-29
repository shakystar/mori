import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

type CredentialsFile = Record<string, Credential>;

/** `$XDG_CONFIG_HOME/mori/credentials.json`, falling back to `~/.config/mori/credentials.json`. */
export function defaultCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "mori", "credentials.json");
}

/**
 * File-backed `CredentialStore` (pi-ai's public interface) holding one credential per
 * provider id, keyed the same way pi-ai's own auth.json is. This file can hold OAuth
 * refresh tokens, so every write lands at 0600 with the parent directory at 0700
 * regardless of umask. Reads never throw: a missing file means "no credentials yet"
 * (normal, silent); a present-but-corrupt file is treated the same way but logs a
 * one-line warning, since a broken cache must not crash the CLI.
 */
export class FileCredentialStore implements CredentialStore {
  private readonly path: string;
  private readonly warn: (message: string) => void;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(path: string, warn: (message: string) => void = (m) => process.stderr.write(m)) {
    this.path = path;
    this.warn = warn;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const all = await this.enqueue(() => this.readAll());
    return all[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const all = await this.enqueue(() => this.readAll());
    return Object.entries(all).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      const all = await this.readAll();
      const next = await fn(all[providerId]);
      if (next === undefined) return all[providerId];
      all[providerId] = next;
      await this.writeAll(all);
      return next;
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.enqueue(async () => {
      const all = await this.readAll();
      if (!(providerId in all)) return;
      delete all[providerId];
      await this.writeAll(all);
    });
  }

  /** Serializes every read/write against this store instance — the file has one owner process. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readAll(): Promise<CredentialsFile> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      this.warn(
        `mori: failed to read ${this.path} (${(error as Error).message}), treating as no stored credentials.\n`,
      );
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("credentials.json must contain a JSON object");
      }
      return parsed as CredentialsFile;
    } catch {
      this.warn(`mori: ${this.path} contains invalid JSON, treating as no stored credentials.\n`);
      return {};
    }
  }

  private async writeAll(all: CredentialsFile): Promise<void> {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await chmod(dir, DIR_MODE);
    await writeFile(this.path, `${JSON.stringify(all, null, 2)}\n`, { mode: FILE_MODE });
    await chmod(this.path, FILE_MODE);
  }
}

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { LlmCallCacheStore } from "./llm-call-cache.js";

/**
 * File-based `LlmCallCacheStore`: one JSON file per cache key under `dir`. `dir` is caller-
 * configured — this module has no opinion on where it lives (the #342 3-tier cadence, #375,
 * points PR-smoke runs at a checked-in fixture dir and nightly/milestone runs at a scratch
 * dir; that choice belongs to the common runner, #374, not here).
 */
/** `key` becomes a filename component (see `pathFor`) — restricted to characters that can
 * never step outside `dir` (no `/`, `\`, or `.`, so `..` can't appear at all). The sole
 * producer today (`llmCallCacheKey`) emits sha256 hex, which is a strict subset of this, but
 * `LlmCallCacheStore` is a public interface and a future caller passing an unsanitized key
 * must fail loudly instead of reading/writing outside `dir`. */
const SAFE_KEY = /^[A-Za-z0-9_-]+$/;

export class FileLlmCallCacheStore implements LlmCallCacheStore {
  constructor(private readonly dir: string) {}

  private pathFor(key: string): string {
    if (!SAFE_KEY.test(key)) {
      throw new Error(`llm cache: invalid key ${JSON.stringify(key)}`);
    }
    return join(this.dir, `${key}.json`);
  }

  async get(key: string): Promise<AssistantMessage | undefined> {
    try {
      const raw = await readFile(this.pathFor(key), "utf8");
      return JSON.parse(raw) as AssistantMessage;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Writes to a per-call temp file, then `rename`s it into place. `rename` replaces the
   * destination atomically on POSIX, so a concurrent `get` for the same key (plausible once
   * #374's common runner parallelizes bench calls that happen to share a cache key) always
   * observes either the previous complete file or the new one — never a partial write from a
   * `writeFile` interleaved with a read.
   */
  async set(key: string, message: AssistantMessage): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp-${randomUUID()}`;
    await writeFile(tmpPath, JSON.stringify(message, null, 2), "utf8");
    await rename(tmpPath, path);
  }
}

/** Matches the `.tmp-<uuid>` suffix `FileLlmCallCacheStore.set` appends before its atomic
 * `rename` — the only files under `dir` this name pattern can belong to. */
const ORPHAN_TMP_SUFFIX = /\.tmp-[0-9a-f-]+$/i;

/**
 * Removes `<key>.json.tmp-<uuid>` files left behind when a process died between `writeFile`
 * and `rename` in `FileLlmCallCacheStore.set` — nothing else ever deletes them (owner review,
 * #374). `dir` has no background TTL sweep or per-write cleanup of prior runs' orphans: the
 * cache directory's lifetime is the bench runner's to own, so the runner (`runner.ts`) calls
 * this once at startup, before any `get`/`set` — a bounded, synchronous-at-call-time sweep
 * beats a timer because a bench run is a single foreground process with a clear "before I read
 * this cache dir" moment, and nothing else touches these files between runs. Missing `dir`
 * (never written to yet) is not an error — there is nothing to sweep.
 */
export async function sweepOrphanCacheTmpFiles(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const orphans = entries.filter((entry) => ORPHAN_TMP_SUFFIX.test(entry));
  await Promise.all(orphans.map((entry) => unlink(join(dir, entry))));
  return orphans.length;
}

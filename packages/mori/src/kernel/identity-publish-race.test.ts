/**
 * #217 review round 3 (Codex P2) — the window between `createMoriKernel`
 * resolving a project's identity as "missing" and it publishing the freshly
 * minted path-hash id to `.mori/project.json`. If another process (a `git
 * checkout`, another `mori` session) publishes its own, different, valid
 * `project.json` inside that window, this call must adopt the winner rather
 * than clobber it — and (#240) must open ITS store under the winner's id too,
 * not just leave the winner's file untouched on disk. The two used to
 * diverge: the file was protected by `link`'s `EEXIST`, but the losing
 * session still built its kernel from the id it minted in memory before the
 * race was decided, so its observations landed in a store no later run's
 * identity resolution would ever find again.
 *
 * The scheduler will not produce that interleaving on demand, so this file
 * wraps `node:fs` to inject the competing write at the exact moment
 * `persistProjectIdentity` writes its temp file — the one call this test
 * arms. Every other `node:fs` call (including the identity file's own
 * `mkdirSync`/`writeFileSync`/`linkSync`) runs the real implementation
 * unmodified (TESTING.md's "타이밍 레이스" exception). The assertion is the
 * observable end state — what `project.json` contains, AND what id the
 * returned handle actually opened its store under — not the mock's call log.
 */

import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMoriKernel } from "./index.js";

const hooks = vi.hoisted(() => ({
  /** Armed with the competing writer's target + content; consumed once. */
  publishOnNextTempWrite: undefined as { targetPath: string; content: string } | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();

  const writeFileSync: typeof actual.writeFileSync = (file, data, options) => {
    actual.writeFileSync(file, data, options);
    const armed = hooks.publishOnNextTempWrite;
    if (armed && String(file).endsWith(".mori-tmp")) {
      hooks.publishOnNextTempWrite = undefined;
      // The competing writer's publish: lands after our temp file exists but
      // before our own `linkSync` runs — `.mori` already exists by now
      // because `persistProjectIdentity` `mkdirSync`s it before this write.
      actual.writeFileSync(armed.targetPath, armed.content, "utf8");
    }
  };

  const patched = { ...actual, writeFileSync };
  return { ...patched, default: patched };
});

let root: string;
let store: string;

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), "mori-identity-race-root-")));
  store = realpathSync(await mkdtemp(join(tmpdir(), "mori-identity-race-store-")));
  process.env.MEMORIZE_ROOT = store;
  hooks.publishOnNextTempWrite = undefined;
});

afterEach(async () => {
  delete process.env.MEMORIZE_ROOT;
  hooks.publishOnNextTempWrite = undefined;
  await rm(root, { recursive: true, force: true });
  await rm(store, { recursive: true, force: true });
});

describe("createMoriKernel — identity publish race (#217 review round 3, #240)", () => {
  it("adopts an identity another writer publishes mid-write instead of clobbering it, and opens its store under that id", async () => {
    const targetPath = join(root, ".mori", "project.json");
    const winner = { id: "proj_winner000000000" };
    hooks.publishOnNextTempWrite = { targetPath, content: JSON.stringify(winner) };

    let handle: ReturnType<typeof createMoriKernel> | undefined;
    expect(() => {
      handle = createMoriKernel({ root, env: {} });
    }).not.toThrow();

    const persisted: unknown = JSON.parse(await readFile(targetPath, "utf8"));
    expect(persisted).toEqual(winner);
    // #240: the file alone is not enough — this session's kernel must have
    // been constructed with the winner's id, not the path hash it minted
    // before losing the race, or its observations go to an orphaned store.
    expect(handle?.projectId).toBe(winner.id);
  });

  it("keeps its own path hash and leaves the file untouched when the winner publishes something unusable", async () => {
    const targetPath = join(root, ".mori", "project.json");
    hooks.publishOnNextTempWrite = { targetPath, content: "{not valid json" };

    let handle: ReturnType<typeof createMoriKernel> | undefined;
    expect(() => {
      handle = createMoriKernel({ root, env: {} });
    }).not.toThrow();

    // Never-overwrite (#217): an unusable winner file is left exactly as
    // published, not replaced with this session's own temp copy.
    const persisted = await readFile(targetPath, "utf8");
    expect(persisted).toBe("{not valid json");
    // #240: an unusable winner must not be adopted — this session keeps the
    // path hash it already resolved in memory.
    expect(handle?.projectId).toMatch(/^proj_[0-9a-f]{16}$/);
    expect(handle?.projectId).not.toBe("proj_winner000000000");
  });
});

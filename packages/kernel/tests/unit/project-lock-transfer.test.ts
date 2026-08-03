/**
 * #132, PR #156 review Codex P1 ① / P2 ④ — the two moments when a lock changes
 * hands, driven at the filesystem calls that make them racy.
 *
 * Both cases need an interleaving the scheduler will not produce on its own, so
 * `node:fs/promises` is wrapped and armed per test: one hook delays a chosen
 * `rm`, the other fails a chosen owner write. Everything else delegates to the
 * real module, and the hooks are inert unless a test arms them — the sandbox
 * setup and teardown run at full speed.
 *
 * These live apart from `project-lock.test.ts` so that the mock covers only the
 * cases that need it.
 *
 * `vi.mock` on `node:fs/promises` is otherwise off-limits (TESTING.md) — this file is
 * one of the two documented exceptions ("예외: 타이밍 레이스·장애 주입"): the interleaving
 * and the `ENOSPC` write failure can't be produced by the scheduler or a real full disk on
 * demand, and the assertions below check observable outcomes (overlap, lock directory
 * state), not the mock's call log.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getProjectLockDir, withProjectLock } from "../../src/storage/project-lock.js";

const hooks = vi.hoisted(() => ({
  /** One delay (ms) per upcoming `rm`, consumed in call order. */
  rmDelaysMs: [] as number[],
  /** When set, the next `owner.json` write fails with this code. */
  failOwnerWriteCode: undefined as string | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();

  const rm: typeof actual.rm = async (target, options) => {
    const delayMs = hooks.rmDelaysMs.shift() ?? 0;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return actual.rm(target, options);
  };

  const writeFile: typeof actual.writeFile = async (file, data, options) => {
    if (hooks.failOwnerWriteCode && String(file).endsWith("owner.json")) {
      const code = hooks.failOwnerWriteCode;
      hooks.failOwnerWriteCode = undefined;
      const error: NodeJS.ErrnoException = new Error(`simulated ${code} writing ${String(file)}`);
      error.code = code;
      throw error;
    }
    return actual.writeFile(file, data, options);
  };

  const patched = { ...actual, rm, writeFile };
  return { ...patched, default: patched };
});

let sandbox: string;
const projectId = "proj_lock_transfer_test";

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-project-lock-transfer-"));
  process.env.MEMORIZE_ROOT = sandbox;
  hooks.rmDelaysMs.length = 0;
  hooks.failOwnerWriteCode = undefined;
});

afterEach(async () => {
  delete process.env.MEMORIZE_ROOT;
  hooks.rmDelaysMs.length = 0;
  hooks.failOwnerWriteCode = undefined;
  await rm(sandbox, { recursive: true, force: true });
});

/** A lock left behind by a process that is definitely gone (`kill -9`). */
async function plantAbandonedLock(): Promise<string> {
  const lockDir = getProjectLockDir(projectId);
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    join(lockDir, "owner.json"),
    JSON.stringify({
      token: "abandoned-token",
      // Above every platform's pid_max, so `kill(pid, 0)` answers ESRCH.
      pid: 0x7fffffff,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
    }),
  );
  return lockDir;
}

describe("withProjectLock — reclaiming an abandoned lock", () => {
  it("lets only one of two racing reclaimers into the critical section", async () => {
    // Both waiters judge the same abandoned lock reclaimable in the same tick.
    // The first clears it, takes it and starts working; the second is held up
    // just long enough that its own removal lands AFTER that — on a lock that
    // is now alive. An unconditional removal there evicts a running holder and
    // both bodies overlap (PR #156 review, Codex P1 ①). Transfer has to be
    // bound to the instance that was judged, not to the path.
    await plantAbandonedLock();
    hooks.rmDelaysMs.push(0, 120);

    let inside = 0;
    let overlapped = false;
    const body = async (): Promise<void> => {
      inside += 1;
      if (inside > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 250));
      inside -= 1;
    };
    const options = { acquireTimeoutMs: 5_000, staleMs: 5_000 };

    await Promise.all([
      withProjectLock(projectId, body, options),
      withProjectLock(projectId, body, options),
    ]);

    expect(overlapped).toBe(false);
    expect(existsSync(getProjectLockDir(projectId))).toBe(false);
  });
});

describe("withProjectLock — a half-created lock", () => {
  it("leaves no orphan directory when the owner write fails", async () => {
    // `mkdir` won, the owner write did not. Leaving the directory behind turns
    // one transient metadata failure into a lock nobody can take until the
    // stale window elapses — a dropped observation per capture, for 30 seconds
    // (PR #156 review, Codex P2 ④).
    hooks.failOwnerWriteCode = "ENOSPC";

    await expect(withProjectLock(projectId, async () => "never")).rejects.toThrow(/simulated/);
    expect(existsSync(getProjectLockDir(projectId))).toBe(false);

    // The proof that matters: the next acquirer is not made to wait it out.
    await expect(
      withProjectLock(projectId, async () => "next", { acquireTimeoutMs: 300 }),
    ).resolves.toBe("next");
  });
});

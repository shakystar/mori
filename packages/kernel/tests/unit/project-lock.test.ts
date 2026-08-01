import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getProjectLockDir,
  ProjectLockCompromisedError,
  ProjectLockTimeoutError,
  withProjectLock,
} from "../../src/storage/project-lock.js";

let sandbox: string;
const projectId = "proj_lock_unit_test";

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-project-lock-"));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

/** Plant a lock directory owned by someone else, as another process would leave it. */
async function plantLock(owner: { pid: number; hostname?: string }): Promise<string> {
  const lockDir = getProjectLockDir(projectId);
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    join(lockDir, "owner.json"),
    JSON.stringify({
      token: "foreign-token",
      pid: owner.pid,
      hostname: owner.hostname ?? hostname(),
      acquiredAt: new Date().toISOString(),
    }),
  );
  return lockDir;
}

/** Swallow a rejection the way `enqueue` does, so the chain survives it. */
function noop(): void {}

/** A pid that cannot be running: `kill(pid, 0)` on it answers ESRCH. */
function deadPid(): number {
  // 0x7FFFFFFF is above every platform's pid_max, so it is never allocated.
  return 0x7fffffff;
}

describe("withProjectLock — acquire / release", () => {
  it("creates the lock under the project root and removes it when the body settles", async () => {
    const lockDir = getProjectLockDir(projectId);

    const held = await withProjectLock(projectId, async () => {
      expect(existsSync(lockDir)).toBe(true);
      const owner = JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8")) as {
        pid: number;
        hostname: string;
      };
      expect(owner.pid).toBe(process.pid);
      expect(owner.hostname).toBe(hostname());
      return "done";
    });

    expect(held).toBe("done");
    expect(existsSync(lockDir)).toBe(false);
  });

  it("releases the lock when the body throws, so a failure does not wedge the store", async () => {
    const lockDir = getProjectLockDir(projectId);

    await expect(
      withProjectLock(projectId, () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");

    expect(existsSync(lockDir)).toBe(false);
    // …and the next acquisition still works.
    await expect(withProjectLock(projectId, async () => "next")).resolves.toBe("next");
  });

  it("serializes overlapping holders — the second body starts only after the first returns", async () => {
    const order: string[] = [];
    const first = withProjectLock(projectId, async () => {
      order.push("first:enter");
      await new Promise((resolve) => setTimeout(resolve, 40));
      order.push("first:exit");
    });
    const second = withProjectLock(projectId, async () => {
      order.push("second:enter");
      order.push("second:exit");
    });

    await Promise.all([first, second]);

    expect(order).toEqual(["first:enter", "first:exit", "second:enter", "second:exit"]);
  });

  it("does not create the project root until a lock is actually taken", async () => {
    // The lock lives under the project root, so acquiring it creates that dir —
    // but merely importing/resolving the path must not (README:139-141: a
    // read-only session leaves no trace).
    expect(existsSync(getProjectLockDir(projectId))).toBe(false);
    expect(existsSync(join(sandbox, "projects"))).toBe(false);
  });
});

describe("withProjectLock — stale reclamation", () => {
  it("reclaims a lock whose recorded owner is no longer running (kill -9)", async () => {
    const lockDir = await plantLock({ pid: deadPid() });
    // Fresh mtime: only the pid check can tell this lock is abandoned.
    expect(Date.now() - (await stat(lockDir)).mtimeMs).toBeLessThan(1_000);

    await expect(
      withProjectLock(projectId, async () => "reclaimed", { acquireTimeoutMs: 2_000 }),
    ).resolves.toBe("reclaimed");
  });

  it("never reclaims a live local owner on age, however long it has been silent", async () => {
    // Our own pid, so the liveness check answers "alive" — and age must not
    // override it (PR #156 review, Codex P1 ③). The heartbeat is a
    // `setInterval`, and what stops it is a blocked event loop: a synchronous
    // projection rebuild over a large log, or a suspended machine. Both end
    // with the owner waking up and committing, which is the worst possible
    // moment for a competitor to be inside the same critical section.
    const lockDir = await plantLock({ pid: process.pid });
    const old = new Date(Date.now() - 600_000);
    await utimes(lockDir, old, old);

    await expect(
      withProjectLock(projectId, async () => "should not run", {
        acquireTimeoutMs: 150,
        staleMs: 5_000,
      }),
    ).rejects.toBeInstanceOf(ProjectLockTimeoutError);
  });

  it("names the lock directory in the timeout, so a pid-reuse wedge is fixable", async () => {
    // The price of the rule above: an owner whose pid was inherited by an
    // unrelated process reads as alive forever. That is a loud, one-step
    // failure by design — the message has to carry the step.
    await plantLock({ pid: process.pid });

    await expect(
      withProjectLock(projectId, async () => "should not run", { acquireTimeoutMs: 100 }),
    ).rejects.toThrow(getProjectLockDir(projectId));
  });

  it("does not reclaim a foreign-host lock on age alone before its stale window", async () => {
    await plantLock({ pid: deadPid(), hostname: "some-other-machine" });

    await expect(
      withProjectLock(projectId, async () => "should not run", {
        acquireTimeoutMs: 150,
        staleMs: 30_000,
      }),
    ).rejects.toBeInstanceOf(ProjectLockTimeoutError);
  });

  it("reclaims a foreign-host lock once its stale window has passed", async () => {
    // Age is the only signal we have about another machine's process, so it
    // stays the rule there — that is what keeps a shared home directory from
    // wedging forever.
    const lockDir = await plantLock({ pid: 1, hostname: "some-other-machine" });
    const old = new Date(Date.now() - 60_000);
    await utimes(lockDir, old, old);

    await expect(
      withProjectLock(projectId, async () => "reclaimed", {
        acquireTimeoutMs: 2_000,
        staleMs: 5_000,
      }),
    ).resolves.toBe("reclaimed");
  });
});

describe("withProjectLock — ownership transfer", () => {
  it("does not delete a successor's lock that has not written its owner record yet", async () => {
    // A successor between its `mkdir` and its owner write has a directory and
    // no `owner.json`. Reading that as "unowned, safe to remove" is how the
    // release path used to delete a live lock (PR #156 review, Codex P1 ②).
    const lockDir = getProjectLockDir(projectId);

    await withProjectLock(projectId, async () => {
      await rm(lockDir, { recursive: true, force: true });
      await mkdir(lockDir, { recursive: true });
    });

    expect(existsSync(lockDir)).toBe(true);
    expect(existsSync(join(lockDir, "owner.json"))).toBe(false);
  });

  it("fails the call when the lock is taken over while it is held", async () => {
    // A holder cannot stop an ill-timed detach, so it watches instead: the
    // heartbeat re-reads the owner record, and a span that turned out to be
    // unguarded is reported to the caller instead of passing for a guarded one.
    const lockDir = getProjectLockDir(projectId);

    await expect(
      withProjectLock(
        projectId,
        async () => {
          await rm(lockDir, { recursive: true, force: true });
          await plantLock({ pid: deadPid() });
          await new Promise((resolve) => setTimeout(resolve, 300));
          return "must not be trusted";
        },
        { heartbeatMs: 10 },
      ),
    ).rejects.toBeInstanceOf(ProjectLockCompromisedError);
  });

  it("does not settle before its critical section, so a queued successor cannot overlap it", async () => {
    // Losing the lock must not settle the CALL while the WORK runs on. The
    // kernel chains captures on the previous task's promise, so an early
    // settle starts the next capture on top of a projection rebuild still in
    // flight — this issue's ① recreated inside one process, in the one place
    // `enqueue` had always ruled it out (PR #156 review, Codex P1 ⑤).
    const lockDir = getProjectLockDir(projectId);
    let running = 0;
    let overlapped = false;
    let predecessorStillRunning = false;

    const dispossessed = withProjectLock(
      projectId,
      async () => {
        running += 1;
        // What the timeout message tells a person to do, mistimed: the lock is
        // cleared and taken over while we are still working under it.
        await rm(lockDir, { recursive: true, force: true });
        await plantLock({ pid: deadPid() });
        await new Promise((resolve) => setTimeout(resolve, 200));
        running -= 1;
      },
      { heartbeatMs: 10 },
    );

    // `SqliteMemoryKernel.enqueue`'s chain in miniature: the next capture
    // starts as soon as the previous task settles, whatever its outcome.
    const successor = dispossessed.catch(noop).then(async () => {
      if (running > 0) predecessorStillRunning = true;
      await withProjectLock(
        projectId,
        async () => {
          running += 1;
          if (running > 1) overlapped = true;
          running -= 1;
        },
        { acquireTimeoutMs: 5_000, staleMs: 5_000, heartbeatMs: 10 },
      );
    });

    await expect(dispossessed).rejects.toBeInstanceOf(ProjectLockCompromisedError);
    await successor;

    expect(predecessorStillRunning).toBe(false);
    expect(overlapped).toBe(false);
  });

  it("keeps holding the lock when the owner record is momentarily unreadable", async () => {
    // A dispossessor replaces the whole directory; a truncated `owner.json` is
    // not evidence of one. Treating it as such would abort healthy captures.
    const lockDir = getProjectLockDir(projectId);

    await expect(
      withProjectLock(
        projectId,
        async () => {
          await writeFile(join(lockDir, "owner.json"), "{ truncated");
          await new Promise((resolve) => setTimeout(resolve, 100));
          return "still ours";
        },
        { heartbeatMs: 10 },
      ),
    ).resolves.toBe("still ours");
  });
});

describe("withProjectLock — failure to acquire", () => {
  it("times out rather than waiting forever on a live holder", async () => {
    let release: () => void = () => {};
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withProjectLock(projectId, () => blocker);
    // Let the holder win the mkdir before the contender starts.
    await new Promise((resolve) => setTimeout(resolve, 30));

    await expect(
      withProjectLock(projectId, async () => "never", { acquireTimeoutMs: 120 }),
    ).rejects.toBeInstanceOf(ProjectLockTimeoutError);

    release();
    await holder;
  });

  it("fails fast when the lock path is occupied by something that is not a directory", async () => {
    await mkdir(join(sandbox, "projects", projectId), { recursive: true });
    await writeFile(getProjectLockDir(projectId), "not a lock");

    await expect(withProjectLock(projectId, async () => "never")).rejects.toThrow(
      /not a directory/,
    );
  });
});

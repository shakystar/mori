/**
 * #158 — the cooperative-cancellation half of `withProjectLock`.
 *
 * #132 settled that dispossession is a REPORT, not a brake: `withProjectLock`
 * waits for `fn` to settle and only then fails. That left the overlap lasting
 * as long as the dispossessed `fn` did. This file covers the way out that #158
 * adds — a signal handed INWARD, which `fn` may act on at points of its own
 * choosing — and, just as importantly, pins down that the way out did not turn
 * into a brake: the guarantee ⑤ depends on is that the wait around `fn` is
 * never raced, and it is asserted here again from the side where `fn` actually
 * honours the signal.
 *
 * Kept out of `project-lock.test.ts` on purpose. That file's
 * "does not settle before its critical section…" case is #158's own regression
 * guard, and a guard is worth more when the change it guards against did not
 * get to touch its file.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemorizeError } from "../../src/shared/errors.js";
import {
  getProjectLockDir,
  ProjectLockCompromisedError,
  throwIfDispossessed,
  withProjectLock,
} from "../../src/storage/project-lock.js";

let sandbox: string;
const projectId = "proj_lock_cancel_test";

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-project-lock-cancel-"));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

/** Take this project's lock away the way a mistimed reclaim does. */
async function stealLock(): Promise<void> {
  const lockDir = getProjectLockDir(projectId);
  await rm(lockDir, { recursive: true, force: true });
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    join(lockDir, "owner.json"),
    JSON.stringify({
      token: "foreign-token",
      // Above every platform's pid_max, so it is never a running process.
      pid: 0x7fffffff,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
    }),
  );
}

/** Wait until `predicate` holds, or fail loudly rather than hanging the suite. */
async function until(predicate: () => boolean, label: string, capMs = 2_000): Promise<void> {
  const deadline = Date.now() + capMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("withProjectLock — the signal handed to fn", () => {
  it("is live and un-aborted for a section that keeps its lock", async () => {
    let seen: AbortSignal | undefined;

    const result = await withProjectLock(
      projectId,
      async (signal) => {
        seen = signal;
        expect(signal.aborted).toBe(false);
        // A check point on a healthy section is a no-op, which is what makes it
        // safe to put one anywhere the section is about to commit.
        throwIfDispossessed(signal);
        await new Promise((resolve) => setTimeout(resolve, 40));
        throwIfDispossessed(signal);
        return "kept";
      },
      { heartbeatMs: 10 },
    );

    expect(result).toBe("kept");
    expect(seen?.aborted).toBe(false);
    expect(existsSync(getProjectLockDir(projectId))).toBe(false);
  });

  it("aborts within a heartbeat of the lock being taken, carrying the verdict as its reason", async () => {
    let reason: unknown;

    await expect(
      withProjectLock(
        projectId,
        async (signal) => {
          await stealLock();
          await until(() => signal.aborted, "the heartbeat to notice the takeover");
          reason = signal.reason;
          // Not thrown here: this case is about the SIGNAL, and the assertion
          // below is that a section which ignores it still fails the same way.
          return "ran to the end anyway";
        },
        { heartbeatMs: 10 },
      ),
    ).rejects.toBeInstanceOf(ProjectLockCompromisedError);

    expect(reason).toBeInstanceOf(ProjectLockCompromisedError);
    expect((reason as Error).message).toContain(projectId);
  });

  it("gives a section that stops itself the same rejection as one that runs on", async () => {
    // The whole point of routing the verdict through `signal.reason`: #132's
    // rule is that `withProjectLock` never overwrites `fn`'s own rejection, and
    // that rule needs no exception here because `fn`'s rejection IS the verdict.
    const stopped = await withProjectLock(
      projectId,
      async (signal) => {
        await stealLock();
        await until(() => signal.aborted, "the heartbeat to notice the takeover");
        throwIfDispossessed(signal);
        throw new Error("unreachable — the check point above throws");
      },
      { heartbeatMs: 10 },
    ).catch((error: unknown) => error);

    expect(stopped).toBeInstanceOf(ProjectLockCompromisedError);
    expect((stopped as Error).message).toContain(projectId);
  });

  it("still does not settle before its critical section, even when the section honours the signal", async () => {
    // ⑤ from the other side. `project-lock.test.ts` pins the case where `fn`
    // ignores the signal; this one pins the case #158 introduces — `fn` notices,
    // bails out of its main work, and STILL has cleanup to run. If honouring the
    // signal ever came to mean "the call settles now", a queued successor would
    // start on top of that cleanup, which is the ① this module exists to end.
    let inCleanup = false;
    let successorSawCleanup = false;

    const dispossessed = withProjectLock(
      projectId,
      async (signal) => {
        await stealLock();
        await until(() => signal.aborted, "the heartbeat to notice the takeover");
        try {
          throwIfDispossessed(signal);
        } finally {
          inCleanup = true;
          await new Promise((resolve) => setTimeout(resolve, 150));
          inCleanup = false;
        }
      },
      { heartbeatMs: 10 },
    );

    // `SqliteMemoryKernel.enqueue`'s chain in miniature: the next task starts as
    // soon as the previous one settles, whatever its outcome.
    const successor = dispossessed
      .catch(() => {})
      .then(() => {
        if (inCleanup) successorSawCleanup = true;
      });

    await expect(dispossessed).rejects.toBeInstanceOf(ProjectLockCompromisedError);
    await successor;

    expect(successorSawCleanup).toBe(false);
  });
});

describe("throwIfDispossessed", () => {
  it("passes through when there is no signal at all", () => {
    // The shape every pre-#158 caller has: no lock, no signal, no cancellation.
    expect(() => throwIfDispossessed(undefined)).not.toThrow();
  });

  it("passes through on a signal that has not fired", () => {
    expect(() => throwIfDispossessed(new AbortController().signal)).not.toThrow();
  });

  it("rethrows a foreign abort reason rather than silently continuing", () => {
    // Not a shape this module produces, but a stop order is a stop order — the
    // one thing a check point must never do is treat an abort it does not
    // recognize as permission to commit.
    const controller = new AbortController();
    controller.abort(new Error("someone else's reason"));

    expect(() => throwIfDispossessed(controller.signal)).toThrow("someone else's reason");
  });

  it("wraps a non-Error reason so a check point always throws something throwable", () => {
    // `abort()` with no argument gives a DOMException, which IS an Error — the
    // branch this covers is `abort("some string")`, where rethrowing the reason
    // verbatim would send a bare string up a stack that expects errors.
    const controller = new AbortController();
    controller.abort("cancelled by hand");

    expect(() => throwIfDispossessed(controller.signal)).toThrow(MemorizeError);
    expect(() => throwIfDispossessed(controller.signal)).toThrow("cancelled by hand");
  });
});

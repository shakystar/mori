/**
 * Project-scoped, cross-PROCESS mutual exclusion for the store under
 * `getProjectRoot(projectId)` (#132).
 *
 * Everything the kernel had before this was object-scoped and therefore could
 * not cross a process boundary: `SqliteMemoryKernel`'s `enqueue` chain is an
 * instance field, and the harness's `chains` `WeakMap` is keyed by kernel
 * identity. Two `mori` processes opened on the same working root resolve the
 * same `projectId` and write the same database, so both of the kernel's
 * read-modify-write spans were unguarded across them:
 *
 * - **Capture.** `captureObservation` appends the event and then rebuilds the
 *   projection by REPLACING it from a snapshot of the log read moments earlier.
 *   Interleave two of those and the later replace-all commits a snapshot taken
 *   before the other's append: the observation stays in the event log and
 *   disappears from the projection indefinitely (PR #127 Codex P1). The same
 *   gap lets both processes pass the `hasGenesisEvent` check and append two
 *   `project.created` events.
 * - **Boundary.** Two consolidations read the same watermark before either
 *   advances it, and both distill the same window (PR #130 Codex P1).
 *
 * The lock is a DIRECTORY, created with `fs.mkdir` — `mkdir` on an existing
 * path fails with `EEXIST` on every platform mori supports, which is the whole
 * atomicity requirement. Deliberately no new dependency: `proper-lockfile` and
 * friends buy retry policy and process-liveness checks that are ~80 lines here,
 * and this repo has already spent two issues (#11, #94) removing exactly that
 * kind of inherited dependency.
 *
 * Related but separate: `fs-utils.ts`'s {@link withFileLock} guards an
 * arbitrary FILE path (the event-store's own use, #18) and takes no view of
 * project identity or of who owns the lock. This module is the project-scoped
 * one — it knows the path rule, records an owner, and reclaims after a crash.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MemorizeError } from "../shared/errors.js";
import { ensureDir, isEnoent } from "./fs-utils.js";
import { getProjectRoot } from "./path-resolver.js";

/** Lock directory name, directly under the project root (`path-resolver.ts`'s rule). */
const LOCK_DIR_NAME = "kernel.lock";

/** Owner record, written inside the lock dir right after the winning `mkdir`. */
const OWNER_FILE_NAME = "owner.json";

/**
 * How long a lock may go without a heartbeat before another acquirer treats it
 * as abandoned and removes it.
 *
 * The holder refreshes the lock's mtime every {@link LOCK_HEARTBEAT_MS} while
 * it works, so this is NOT a bound on how long a critical section may run — a
 * consolidation boundary that spends two minutes inside an extraction LLM call
 * keeps its lock the whole time. It is only a bound on how long a DEAD owner's
 * lock survives: six missed beats, which is slack enough that a busy event loop
 * (a synchronous projection rebuild over a large log) cannot be mistaken for a
 * corpse.
 */
const LOCK_STALE_MS = 30_000;

/** Heartbeat period; {@link LOCK_STALE_MS} / 6. Unref'd, so it never holds the process open. */
const LOCK_HEARTBEAT_MS = 5_000;

/**
 * Upper bound on waiting for someone else's lock.
 *
 * Chosen strictly GREATER than {@link LOCK_STALE_MS} on purpose: a crashed
 * owner is reclaimed after at most `LOCK_STALE_MS` (sooner, when the PID check
 * below settles it immediately), so hitting this timeout means a LIVE holder
 * genuinely ran for a minute — a wedged extractor, not a corpse. That
 * distinction is what makes the timeout reportable rather than routine.
 *
 * It is bounded at all because the capture path must not be able to hang an
 * agent's session-end drain forever; a dropped observation degrades memory,
 * a hung boundary hangs the user.
 */
const LOCK_ACQUIRE_TIMEOUT_MS = 60_000;

/** Poll backoff bounds while waiting for a held lock. */
const POLL_MIN_MS = 10;
const POLL_MAX_MS = 250;

/**
 * Grace period after the winning `mkdir` before re-reading the owner file to
 * confirm we are still the recorded owner. Covers the one race `mkdir` alone
 * cannot: another acquirer judged this lock stale and replaced it between our
 * `mkdir` and our owner write.
 */
const LOCK_SETTLE_MS = 10;

export interface ProjectLockOptions {
  /** Override {@link LOCK_ACQUIRE_TIMEOUT_MS}. Tests only — callers use the default. */
  acquireTimeoutMs?: number;
  /** Override {@link LOCK_STALE_MS}. Tests only — callers use the default. */
  staleMs?: number;
}

/** Thrown when the lock could not be taken within the acquire timeout. */
export class ProjectLockTimeoutError extends MemorizeError {
  constructor(projectId: string, waitedMs: number) {
    super(
      `Timed out after ${waitedMs}ms waiting for the project lock of ${projectId} ` +
        `(another mori process is holding it)`,
    );
    this.name = "ProjectLockTimeoutError";
  }
}

interface OwnerRecord {
  /** Unique per acquisition — distinguishes our lock from a same-PID re-acquisition. */
  token: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

export function getProjectLockDir(projectId: string): string {
  return path.join(getProjectRoot(projectId), LOCK_DIR_NAME);
}

/**
 * True when `pid` is definitely gone. Only meaningful for a lock recorded on
 * THIS host — a PID from another machine says nothing about ours.
 *
 * `kill(pid, 0)` sends no signal; it only asks whether the process is
 * addressable. `EPERM` means it exists but belongs to another user, which is
 * "alive" for our purposes. PID reuse can make a dead owner look alive, which
 * is why liveness is an accelerator and the heartbeat/mtime check below remains
 * the backstop rather than the other way round.
 */
function isOwnerDead(owner: OwnerRecord): boolean {
  if (owner.hostname !== os.hostname()) return false;
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function readOwner(lockDir: string): Promise<OwnerRecord | undefined> {
  try {
    const raw = await fs.readFile(path.join(lockDir, OWNER_FILE_NAME), "utf8");
    const parsed = JSON.parse(raw) as Partial<OwnerRecord>;
    if (typeof parsed.token !== "string" || typeof parsed.hostname !== "string") return undefined;
    if (typeof parsed.pid !== "number") return undefined;
    return parsed as OwnerRecord;
  } catch {
    // Missing, half-written or corrupt: the caller falls back to the mtime
    // check, which needs no cooperation from the owner.
    return undefined;
  }
}

/**
 * Decide whether an existing lock may be removed.
 *
 * Two independent signals, and they cover each other's blind spot: the PID
 * check reclaims a `kill -9`'d owner on this host instantly but is fooled by
 * PID reuse; the heartbeat/mtime check needs `staleMs` to elapse but is immune
 * to reuse and works for an owner on another machine (a shared home directory).
 */
async function isReclaimable(lockDir: string, staleMs: number): Promise<boolean> {
  let stat;
  try {
    stat = await fs.stat(lockDir);
  } catch (error) {
    // Gone while we looked — the next mkdir will simply succeed.
    if (isEnoent(error)) return false;
    throw error;
  }
  if (!stat.isDirectory()) {
    // A plain file where the lock dir belongs is not a lock we can reason
    // about, and no amount of waiting will turn it into one. Fail loudly
    // instead of spinning until the acquire timeout.
    throw new MemorizeError(`Project lock path exists but is not a directory: ${lockDir}`);
  }

  const owner = await readOwner(lockDir);
  if (owner && isOwnerDead(owner)) return true;
  return Date.now() - stat.mtimeMs > staleMs;
}

/**
 * Run `fn` while holding this project's lock, then release it.
 *
 * The lock directory lives under `getProjectRoot(projectId)`, so acquiring it
 * creates that directory when it is missing. That is not "the lock creating the
 * store": `projectStoreExists` keys off the DATABASE file, and every caller of
 * this function is on its way to `ensureProjectDirectories` in the same breath.
 * A session that captures nothing and consolidates nothing never gets here at
 * all, which is what keeps the read-only-turn guarantee (README:139-141) intact.
 *
 * NOT reentrant. A holder must not call back into this function for the same
 * project — see `SqliteMemoryKernel.consolidateWithResult`, which drains its
 * capture queue OUTSIDE the lock precisely because those queued captures take
 * it themselves.
 */
export async function withProjectLock<T>(
  projectId: string,
  fn: () => Promise<T>,
  options: ProjectLockOptions = {},
): Promise<T> {
  const acquireTimeoutMs = options.acquireTimeoutMs ?? LOCK_ACQUIRE_TIMEOUT_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const lockDir = getProjectLockDir(projectId);
  const owner: OwnerRecord = {
    token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };

  await acquire(lockDir, owner, acquireTimeoutMs, staleMs, projectId);

  const heartbeat = setInterval(() => {
    const now = new Date();
    void fs.utimes(lockDir, now, now).catch(() => {
      // Released, or reclaimed under us. Nothing useful to do from a timer.
    });
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await release(lockDir, owner.token);
  }
}

async function acquire(
  lockDir: string,
  owner: OwnerRecord,
  acquireTimeoutMs: number,
  staleMs: number,
  projectId: string,
): Promise<void> {
  const deadline = Date.now() + acquireTimeoutMs;
  let backoffMs = POLL_MIN_MS;

  for (;;) {
    const attempt = await tryAcquireOnce(lockDir, owner);
    if (attempt === "acquired") return;

    // "retry" = the project root was missing and we just created it; the lock
    // itself was never contended, so go straight back to the mkdir. The
    // reclaim path likewise loops without backing off — it made progress.
    // Both still honour the deadline, so no filesystem pathology can spin here
    // forever.
    const reclaimed = attempt === "held" && (await isReclaimable(lockDir, staleMs));
    if (reclaimed) {
      await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
    }
    if (Date.now() >= deadline) {
      throw new ProjectLockTimeoutError(projectId, acquireTimeoutMs);
    }
    if (attempt === "retry" || reclaimed) continue;

    const jitter = Math.random() * backoffMs;
    await sleep(Math.min(backoffMs + jitter, Math.max(0, deadline - Date.now()) + 1));
    backoffMs = Math.min(backoffMs * 2, POLL_MAX_MS);
  }
}

type AcquireAttempt = "acquired" | "held" | "retry";

/** One `mkdir` attempt plus the settle re-read. */
async function tryAcquireOnce(lockDir: string, owner: OwnerRecord): Promise<AcquireAttempt> {
  try {
    await fs.mkdir(lockDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return "held";
    if (code === "ENOENT") {
      // The project root does not exist yet — this is the first write into
      // this store. Create it and retry the mkdir.
      await ensureDir(path.dirname(lockDir));
      return "retry";
    }
    throw error;
  }

  await fs.writeFile(path.join(lockDir, OWNER_FILE_NAME), JSON.stringify(owner));
  await sleep(LOCK_SETTLE_MS);
  const current = await readOwner(lockDir);
  if (current?.token === owner.token) return "acquired";

  // Someone reclaimed this lock as stale between our mkdir and our write, and
  // now owns it. Do not remove theirs — just go back to waiting.
  return "held";
}

/** Remove the lock, but only while it is still ours (a reclaimer may own it now). */
async function release(lockDir: string, token: string): Promise<void> {
  const current = await readOwner(lockDir);
  if (current && current.token !== token) return;
  await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

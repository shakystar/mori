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
 * ## How ownership moves
 *
 * The lock is a DIRECTORY created with `fs.mkdir` — `mkdir` on an existing path
 * fails with `EEXIST` on every platform mori supports, which is the whole
 * atomicity requirement for TAKING A FREE LOCK. Deliberately no new dependency:
 * `proper-lockfile` and friends buy retry policy and process-liveness checks
 * that are ~100 lines here, and this repo has already spent two issues (#11,
 * #94) removing exactly that kind of inherited dependency.
 *
 * Taking a free lock is the easy half. The hard half is taking one AWAY from a
 * crashed owner, because a filesystem offers no compare-and-swap: "this lock is
 * abandoned" and "therefore remove it" are separate syscalls, and in between the
 * lock can be released, taken again, and be very much alive. Removing it in
 * place is how a lock silently stops being one (PR #156 review, Codex P1 ①②).
 * So this module never removes `lockDir` in place. One rule covers every
 * transfer:
 *
 * > **Detach, then judge.** An instance is taken with
 * > `rename(lockDir, <unique private path>)`. `rename` is atomic, so for any
 * > given instance exactly one process can detach it and the losers get
 * > `ENOENT` instead of doing damage. What the winner holds is now PRIVATE —
 * > unreachable by anyone else, so it cannot change while being examined. Only
 * > then does the detacher read the owner record and decide whether this is the
 * > instance it meant to take. If it is, dispose of it; if it is not — the lock
 * > turned over between the decision and the `rename` — put it back with
 * > `rename(<private path>, lockDir)` and start over.
 *
 * Reclaiming a crashed owner's lock, releasing our own, and rolling back a
 * half-created one all go through {@link detachAndJudge}. The judgment differs;
 * the mechanism does not.
 *
 * ## How a holder notices it was dispossessed
 *
 * "Detach, then judge" makes an ill-timed detach harmless — the instance goes
 * back — but it cannot make one impossible: the restore fails if a third party
 * has already created a new lock at the path. So a holder watches its own lock
 * instead of assuming it. The heartbeat that refreshes the mtime also re-reads
 * `owner.json`, and a holder whose lock has vanished or now records someone
 * else's token declares it COMPROMISED. Capture surfaces that through
 * `onCaptureError` (one dropped observation); a boundary propagates it. Both
 * beat the silence this module exists to end.
 *
 * That notice is a REPORT, not a brake, and this module is careful not to act
 * as if it were one. A running promise cannot be cancelled from outside, so
 * `withProjectLock` still waits for `fn` to settle and only then fails with
 * {@link ProjectLockCompromisedError}. Settling the wait early — racing the
 * signal against `fn` — would hand the caller a finished call while the work
 * went on running, and the caller that suffers most is the kernel's own capture
 * chain: `enqueue` reads a settled task as "that capture is done" and starts
 * the next one on top of a replace-all projection rebuild still in flight. That
 * is this issue's ① reproduced INSIDE one process, in the one place that had
 * always been safe from it (PR #156 review, Codex P1 ⑤).
 *
 * ## The overlap that remains
 *
 * One third-party race can still put two critical sections in flight, and it is
 * worth naming precisely (PR #156 review, Codex P1 ⑥). A detacher that judges a
 * private instance NOT to be the one it meant to take restores it — but the
 * restore needs the path to be free, and a third acquirer may have `mkdir`'d
 * there first. The restore then fails and the detacher disposes of a lock that
 * belongs to a live holder, who now shares the section with that third
 * acquirer. Entry is narrow: the filter in {@link acquire} does not disturb
 * locks whose local owner is alive, so reaching the restore path at all takes a
 * lock turning over between the filter and the `rename`.
 *
 * How long it lasts is the honest part. The dispossessed holder learns within
 * one heartbeat, but learning is not stopping: with no cooperative cancellation
 * in the critical sections, the overlap ends when the dispossessed `fn` ends.
 * Passing an `AbortSignal` down to the projection swap and the boundary append
 * would shorten it to the next check point; it changes service signatures and
 * is deliberately left out of this module.
 *
 * That is still the better failure. The overlap this module exists to end is
 * unbounded, unconditional and SILENT — every pair of processes, every capture,
 * discovered only as a memory that is missing. This one needs a three-way race
 * to start, and it announces itself to the loser: one reported error against a
 * store that quietly loses observations.
 *
 * Related but separate: `fs-utils.ts`'s {@link withFileLock} guards an
 * arbitrary FILE path (the event-store's own use, #18) and takes no view of
 * project identity or of who owns the lock. This module is the project-scoped
 * one — it knows the path rule, records an owner, and reclaims after a crash.
 */

import type { Stats } from "node:fs";
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
 * How long a lock whose owner we CANNOT interrogate may go without a heartbeat
 * before another acquirer treats it as abandoned.
 *
 * That is two cases and only two: an owner recorded on another host (a shared
 * home directory — we cannot ask about a process on another machine) and an
 * instance whose owner record is missing or corrupt. A lock owned by a live
 * process on THIS host is never reclaimed on age, however long it has been
 * silent — see {@link isAbandoned}.
 *
 * The holder refreshes the lock's mtime every {@link LOCK_HEARTBEAT_MS} while
 * it works, so this is not a bound on how long a critical section may run: a
 * consolidation boundary that spends two minutes inside an extraction LLM call
 * keeps its lock the whole time.
 */
const LOCK_STALE_MS = 30_000;

/** Heartbeat period; {@link LOCK_STALE_MS} / 6. Unref'd, so it never holds the process open. */
const LOCK_HEARTBEAT_MS = 5_000;

/**
 * Upper bound on waiting for someone else's lock.
 *
 * Chosen strictly GREATER than {@link LOCK_STALE_MS} on purpose: an
 * uninterrogable owner is reclaimed after at most `LOCK_STALE_MS`, and a dead
 * local one immediately, so hitting this timeout means a LIVE holder genuinely
 * ran for a minute — a wedged extractor, not a corpse. That distinction is what
 * makes the timeout reportable rather than routine.
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
 * confirm we are still the recorded owner.
 *
 * A backstop, not the mechanism: "detach, then judge" is what keeps a live lock
 * from being carried off. This catches the residue — a detacher putting an
 * instance back can only do so while the path is free, and its `rename` will
 * overwrite an empty directory another acquirer has just `mkdir`'d. The victim
 * of that is always mid-acquisition, and this re-read is how it finds out.
 */
const LOCK_SETTLE_MS = 10;

export interface ProjectLockOptions {
  /** Override {@link LOCK_ACQUIRE_TIMEOUT_MS}. Tests only — callers use the default. */
  acquireTimeoutMs?: number;
  /** Override {@link LOCK_STALE_MS}. Tests only — callers use the default. */
  staleMs?: number;
  /** Override {@link LOCK_HEARTBEAT_MS}. Tests only — callers use the default. */
  heartbeatMs?: number;
}

/** Thrown when the lock could not be taken within the acquire timeout. */
export class ProjectLockTimeoutError extends MemorizeError {
  constructor(projectId: string, waitedMs: number, lockDir: string) {
    super(
      `Timed out after ${waitedMs}ms waiting for the project lock of ${projectId} ` +
        `(another mori process is holding it). If no mori process is running, ` +
        `remove ${lockDir} to clear it.`,
    );
    this.name = "ProjectLockTimeoutError";
  }
}

/**
 * Thrown when the lock was taken away from us while we were inside it.
 *
 * A verdict on work that has already happened, not a brake on it. The critical
 * section is running by the time the heartbeat notices and it runs to
 * completion — `withProjectLock` waits for it and reports afterwards, because
 * settling the call while the work continues is its own corruption (see the
 * module doc). What this buys is that the span cannot be MISTAKEN for a guarded
 * one: an overlap that would otherwise have committed in silence reaches the
 * caller.
 */
export class ProjectLockCompromisedError extends MemorizeError {
  constructor(projectId: string) {
    super(
      `The project lock of ${projectId} was taken over by another process while it ` +
        `was held; the work it was guarding is not safe to trust.`,
    );
    this.name = "ProjectLockCompromisedError";
  }
}

interface OwnerRecord {
  /** Unique per acquisition — distinguishes our lock from a same-PID re-acquisition. */
  token: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

/** A lock instance as seen at one path at one moment. */
interface InstanceView {
  stat: Stats;
  owner: OwnerRecord | undefined;
}

export function getProjectLockDir(projectId: string): string {
  return path.join(getProjectRoot(projectId), LOCK_DIR_NAME);
}

/** True when the owner record was written by a process on this machine. */
function isLocalOwner(owner: OwnerRecord): boolean {
  return owner.hostname === os.hostname() && Number.isInteger(owner.pid) && owner.pid > 0;
}

/**
 * True when a LOCAL `pid` is definitely gone.
 *
 * `kill(pid, 0)` sends no signal; it only asks whether the process is
 * addressable. `EPERM` means it exists but belongs to another user, which is
 * "alive" for our purposes.
 */
function isPidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
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
 * Look at whatever is at `target`, or `undefined` when nothing is.
 *
 * Throws for a non-directory: a plain file where a lock belongs is not a lock
 * we can reason about, and no amount of waiting will turn it into one.
 */
async function inspect(target: string): Promise<InstanceView | undefined> {
  let stat: Stats;
  try {
    stat = await fs.stat(target);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new MemorizeError(`Project lock path exists but is not a directory: ${target}`);
  }
  return { stat, owner: await readOwner(target) };
}

/**
 * Whether an instance may be taken away from its recorded owner.
 *
 * When the owner is a process on this host the OS is authoritative and age is
 * not evidence: `kill(pid, 0)` answers the question outright, so a live owner
 * keeps its lock however long its heartbeat has been silent. The heartbeat is a
 * `setInterval`, and what stops it running is a blocked event loop — a
 * synchronous projection rebuild over a large log, or a suspended laptop —
 * which is precisely when the owner is about to wake up and commit (PR #156
 * review, Codex P1 ③). Reclaiming there recreates the corruption this module
 * exists to prevent.
 *
 * Age stays the only available signal for an owner on another host, and for an
 * instance whose owner record cannot be read at all.
 *
 * The residue is PID reuse: a crashed owner whose number has been inherited by
 * an unrelated process reads as alive forever, so its lock is never reclaimed.
 * We accept that, because the alternative is a clock racing an unbounded
 * critical section — which is exactly what ③ is. This failure is loud and
 * fixable in one step ({@link ProjectLockTimeoutError} names the directory to
 * remove); an over-eager reclaim is silent and corrupts the store.
 */
function isAbandoned(view: InstanceView, staleMs: number): boolean {
  const owner = view.owner;
  if (owner && isLocalOwner(owner)) return isPidGone(owner.pid);
  return Date.now() - view.stat.mtimeMs > staleMs;
}

/**
 * Take the instance currently at `lockDir` out of everyone else's reach, decide
 * whether it is the one we meant to take, and either dispose of it or put it
 * back. The one place ownership is ever transferred — see the module doc.
 *
 * `accept` runs against the DETACHED instance, where it cannot change under us.
 */
async function detachAndJudge(
  lockDir: string,
  privatePath: string,
  accept: (view: InstanceView) => boolean,
): Promise<"disposed" | "restored" | "absent"> {
  try {
    await fs.rename(lockDir, privatePath);
  } catch (error) {
    // Someone else detached it first, or it was released outright. Either way
    // we did no damage and there is nothing here to transfer.
    if (isEnoent(error)) return "absent";
    throw error;
  }

  let view: InstanceView | undefined;
  try {
    view = await inspect(privatePath);
  } catch {
    // Unreadable — not something we can claim to recognize. Put it back.
    view = undefined;
  }

  if (view && accept(view)) {
    await fs.rm(privatePath, { recursive: true, force: true }).catch(() => {});
    return "disposed";
  }

  try {
    await fs.rename(privatePath, lockDir);
    return "restored";
  } catch {
    // The path is occupied again, so a NEWER instance already owns this lock
    // and the one in our hands is obsolete whatever we do with it. Dropping it
    // beats leaving a stray directory behind.
    await fs.rm(privatePath, { recursive: true, force: true }).catch(() => {});
    return "disposed";
  }
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
  const heartbeatMs = options.heartbeatMs ?? LOCK_HEARTBEAT_MS;
  const lockDir = getProjectLockDir(projectId);
  const owner: OwnerRecord = {
    token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };

  await acquire(lockDir, owner, acquireTimeoutMs, staleMs, projectId);

  // Set by the heartbeat, read once `fn` has settled. A flag rather than a
  // racing promise on purpose — see "How a holder notices it was dispossessed".
  let dispossessed = false;

  const heartbeat = setInterval(() => {
    void beat();
  }, heartbeatMs);
  heartbeat.unref();

  function lose(): void {
    dispossessed = true;
    clearInterval(heartbeat);
  }

  async function beat(): Promise<void> {
    const now = new Date();
    try {
      await fs.utimes(lockDir, now, now);
    } catch (error) {
      // Gone means gone: only an owner or a reclaimer removes a lock, and we
      // are the owner. Any other error (a full disk, say) says nothing about
      // ownership and is no reason to declare the lock lost.
      if (isEnoent(error)) lose();
      return;
    }
    const current = await readOwner(lockDir);
    // An unreadable record is NOT evidence of a takeover — a dispossessor
    // replaces the whole directory, which the check above already catches.
    if (current && current.token !== owner.token) lose();
  }

  try {
    const result = await fn();
    // Only here, with `fn` settled: a caller who is told this call is over must
    // be able to believe that the work it guarded is over too.
    //
    // A rejection from `fn` itself is left alone rather than overwritten with
    // this one. The caller already learns the section failed, and `fn`'s error
    // is the one that says what went wrong; a lost lock adds no diagnosis a
    // failed span needs.
    if (dispossessed) throw new ProjectLockCompromisedError(projectId);
    return result;
  } finally {
    clearInterval(heartbeat);
    // Reached only once `fn` has settled, so the lock is never handed on while
    // the work it guarded is still running.
    //
    // A holder that was dispossessed skips the release: nothing at the path is
    // ours any more, and detaching to prove it would briefly expose whoever
    // holds it now. Releasing a lock we lost is exactly the in-place removal
    // this module refuses to do.
    if (!dispossessed) await release(lockDir, owner.token);
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
  let attempt = 0;

  for (;;) {
    attempt += 1;
    const result = await tryAcquireOnce(lockDir, owner, attempt);
    if (result === "acquired") return;

    // "retry" = the project root was missing and we just created it; the lock
    // itself was never contended, so go straight back to the mkdir. A reclaim
    // likewise loops without backing off — it made progress. Both still honour
    // the deadline, so no filesystem pathology can spin here forever.
    let progressed = result === "retry";

    if (result === "held") {
      const view = await inspect(lockDir);
      if (!view) {
        // Released while we looked; the next mkdir simply wins.
        progressed = true;
      } else if (isAbandoned(view, staleMs)) {
        // This judgment is only a FILTER — it keeps us from disturbing locks
        // that are plainly alive. The judgment that decides is the one
        // `detachAndJudge` makes on the instance once it is private.
        const outcome = await detachAndJudge(
          lockDir,
          privatePath(lockDir, owner.token, attempt),
          (detached) => isAbandoned(detached, staleMs),
        );
        progressed = outcome !== "restored";
      }
    }

    if (Date.now() >= deadline) {
      throw new ProjectLockTimeoutError(projectId, acquireTimeoutMs, lockDir);
    }
    if (progressed) continue;

    const jitter = Math.random() * backoffMs;
    await sleep(Math.min(backoffMs + jitter, Math.max(0, deadline - Date.now()) + 1));
    backoffMs = Math.min(backoffMs * 2, POLL_MAX_MS);
  }
}

type AcquireAttempt = "acquired" | "held" | "retry";

/** Where a detached instance is parked: unique per attempt, beside the lock. */
function privatePath(lockDir: string, token: string, attempt: number): string {
  return `${lockDir}.detached-${token}-${attempt}`;
}

/** One `mkdir` attempt, its owner write, and the settle re-read. */
async function tryAcquireOnce(
  lockDir: string,
  owner: OwnerRecord,
  attempt: number,
): Promise<AcquireAttempt> {
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

  try {
    await fs.writeFile(path.join(lockDir, OWNER_FILE_NAME), JSON.stringify(owner));
  } catch (error) {
    if (isEnoent(error)) {
      // Our own directory is gone: a detacher carried it off in the instant
      // before we could stamp it. Nothing of ours is left to clean up.
      return "held";
    }
    // A real write failure (ENOSPC, EIO). Leaving the directory behind would
    // turn one transient metadata error into a lock nobody can take until the
    // stale window elapses, so take back the instance we just made — and only
    // that one, which is what the ownerless judgment checks (Codex P2 ④).
    await detachAndJudge(
      lockDir,
      privatePath(lockDir, owner.token, attempt),
      (detached) => !detached.owner,
    );
    throw error;
  }

  await sleep(LOCK_SETTLE_MS);
  const current = await readOwner(lockDir);
  if (current?.token === owner.token) return "acquired";

  // Our instance was carried off between the mkdir and now, and the path
  // belongs to someone else. Do not touch theirs — go back to waiting.
  return "held";
}

/**
 * Give up the lock — by detaching it and confirming what came away is ours.
 *
 * The naive form (read the owner, then remove the directory) has the same
 * TOCTOU as an in-place reclaim: a successor can take the lock between the two
 * steps and we delete a live one (PR #156 review, Codex P1 ②). A MISSING owner
 * record is not permission to delete either — that is what a successor looks
 * like between its `mkdir` and its own owner write — so the judgment demands a
 * positive match on our token.
 */
async function release(lockDir: string, token: string): Promise<void> {
  await detachAndJudge(
    lockDir,
    `${lockDir}.released-${token}`,
    (detached) => detached.owner?.token === token,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

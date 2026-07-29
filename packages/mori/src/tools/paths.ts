import { lstatSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

/** Successful path resolution: `resolved` is absolute, symlink-resolved, and inside root. */
export interface PathGuardOk {
  ok: true;
  resolved: string;
}

/** Failed path resolution. Never thrown — callers must check `ok`. */
export interface PathGuardFailure {
  ok: false;
  reason: string;
}

export type PathGuardResult = PathGuardOk | PathGuardFailure;

/**
 * Shared shape for "operation failed with a reason" results across the tools.
 * Structurally identical to `PathGuardFailure` — most tool failures either come from a
 * failed path guard or report the same way, so callers can return the guard's failure
 * object directly instead of re-wrapping it.
 */
export type Failure = PathGuardFailure;

/**
 * Resolves `requestedPath` against `root` and guarantees the result stays inside `root`.
 *
 * Paths that exist are compared after `realpath` resolution, so a symlink pointing
 * outside `root` is caught even though its own location is inside `root`. Paths that
 * don't exist yet (e.g. a write target) are compared using the realpath of their
 * nearest existing ancestor directory, so a symlinked ancestor can't be used to
 * smuggle a new file outside `root` either.
 */
export function resolveWithinRoot(root: string, requestedPath: string): PathGuardResult {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { ok: false, reason: `working root does not exist: ${root}` };
  }

  const candidate = resolve(realRoot, requestedPath);

  let nearest = candidate;
  while (!existsLstat(nearest)) {
    const parent = dirname(nearest);
    if (parent === nearest) {
      return { ok: false, reason: `path does not resolve to a real location: ${requestedPath}` };
    }
    nearest = parent;
  }

  let realNearest: string;
  try {
    realNearest = realpathSync(nearest);
  } catch {
    return { ok: false, reason: `failed to resolve path: ${requestedPath}` };
  }

  const remainder = candidate.slice(nearest.length);
  const realCandidate = remainder ? realNearest + remainder : realNearest;

  if (!isWithinRoot(realRoot, realNearest) || !isWithinRoot(realRoot, realCandidate)) {
    return { ok: false, reason: `path escapes working root: ${requestedPath}` };
  }

  return { ok: true, resolved: realCandidate };
}

/** `target` must equal `root` or be nested under it — a bare prefix match would let `<root>-evil` through. */
function isWithinRoot(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/**
 * Existence check for the "nearest existing ancestor" walk above.
 *
 * Must use `lstat`, not `stat`/`existsSync`: those follow symlinks, so a symlink
 * whose target doesn't exist yet (a "dangling" symlink) would read as *not existing*,
 * making the walk skip past it to its parent directory and validate the wrong,
 * unresolved path. `lstat` reports on the link itself, so a dangling symlink is
 * still treated as the nearest entry — and the `realpathSync` call right after this
 * loop then fails on it, correctly rejecting the path instead of silently permitting
 * a write through it.
 */
function existsLstat(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

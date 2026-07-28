import { existsSync, realpathSync } from "node:fs";
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
  while (!existsSync(nearest)) {
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

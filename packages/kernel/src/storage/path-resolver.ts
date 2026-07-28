import os from 'node:os';
import path from 'node:path';

import { assertValidId } from '../domain/common.js';
import { isPersonalStoreId } from '../domain/identity/personal-store.js';

/**
 * Root of mori's on-disk kernel state. Ported from memorize's
 * `~/.memorize/accounts/<accountId>/...` tree, but mori has no CLI account
 * concept, so the whole per-account layer collapses into this single root
 * (see #18 PR body for the decision record). `MEMORIZE_ROOT` is kept as the
 * override env var name for consistency with the already-ported
 * `MEMORIZE_ACCOUNT` (domain/identity/account.ts) — the `MEMORIZE_` → `MORI_`
 * prefix cleanup is deferred to #12 so it lands as one rename, not scattered
 * across each port.
 */
export function getMemorizeRoot(): string {
  return process.env.MEMORIZE_ROOT ?? path.join(os.homedir(), '.mori');
}

function ensureWithinRoot(candidate: string, root: string): string {
  const candidateAbs = path.resolve(candidate);
  const rootAbs = path.resolve(root);
  if (
    candidateAbs !== rootAbs &&
    !candidateAbs.startsWith(rootAbs + path.sep)
  ) {
    throw new Error(
      `Path escapes expected root: ${candidateAbs} is outside ${rootAbs}`,
    );
  }
  return candidateAbs;
}

export function getProjectsRoot(): string {
  return path.join(getMemorizeRoot(), 'projects');
}

/**
 * Home of the personal memory store — a SIBLING of `projects/`, deliberately
 * not under it, so the personal store never appears in `listProjects()` and
 * stays out of every project enumeration sweep. mori is single-account, so
 * (unlike memorize) there is exactly one personal store here, not one per
 * account.
 */
export function getPersonalRoot(): string {
  return path.join(getMemorizeRoot(), 'personal');
}

export function getProjectRoot(projectId: string): string {
  assertValidId(projectId, 'projectId');
  // The personal store routes to the single personal dir regardless of which
  // account's id family it belongs to — mori has no account concept to
  // disambiguate further. Every derived path (db file, sync, topics, locks)
  // flows through here, so this single redirect isolates the whole store
  // with no other change.
  if (isPersonalStoreId(projectId)) {
    return getPersonalRoot();
  }
  const projectsRoot = getProjectsRoot();
  return ensureWithinRoot(path.join(projectsRoot, projectId), projectsRoot);
}

export function getProjectDbFile(projectId: string): string {
  const projectRoot = getProjectRoot(projectId);
  return ensureWithinRoot(path.join(projectRoot, 'mori.db'), projectRoot);
}

export function getTopicsDir(projectId: string): string {
  const projectRoot = getProjectRoot(projectId);
  return ensureWithinRoot(path.join(projectRoot, 'topics'), projectRoot);
}

export function getTopicFile(projectId: string, topicId: string): string {
  assertValidId(topicId, 'topicId');
  const topicsDir = getTopicsDir(projectId);
  return ensureWithinRoot(path.join(topicsDir, `${topicId}.md`), topicsDir);
}

export function getSyncFile(projectId: string): string {
  const projectRoot = getProjectRoot(projectId);
  return ensureWithinRoot(
    path.join(projectRoot, 'sync', 'remote.json'),
    projectRoot,
  );
}

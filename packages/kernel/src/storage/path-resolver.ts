import os from "node:os";
import path from "node:path";

import { assertValidId } from "../domain/common.js";
import { DEFAULT_ACCOUNT_ID, isDefaultAccount } from "../domain/identity/account.js";
import { accountOfPersonalStore, isPersonalStoreId } from "../domain/identity/personal-store.js";

/**
 * Root of mori's on-disk kernel state. Ported from memorize's
 * `~/.memorize/accounts/<accountId>/...` tree; #18 originally collapsed the
 * whole per-account layer into this single root (mori had no CLI account
 * concept at the time). Project stores still live directly under here
 * (`projects/<id>/`, no account nesting) — mori remains single-account for
 * projects. Personal stores are the exception: #155 reinstated per-account
 * nesting for them (`getPersonalRoot`) once `getPersonalStoreId` started
 * minting one id per account, since routing every account's personal store
 * to one shared directory silently aliased their data together.
 * `MEMORIZE_ROOT` is kept as the override env var name for consistency with
 * the already-ported `MEMORIZE_ACCOUNT` (domain/identity/account.ts) — the
 * `MEMORIZE_` → `MORI_` prefix cleanup is deferred to #12 so it lands as one
 * rename, not scattered across each port.
 */
export function getMemorizeRoot(): string {
  return process.env.MEMORIZE_ROOT ?? path.join(os.homedir(), ".mori");
}

function ensureWithinRoot(candidate: string, root: string): string {
  const candidateAbs = path.resolve(candidate);
  const rootAbs = path.resolve(root);
  if (candidateAbs !== rootAbs && !candidateAbs.startsWith(rootAbs + path.sep)) {
    throw new Error(`Path escapes expected root: ${candidateAbs} is outside ${rootAbs}`);
  }
  return candidateAbs;
}

export function getProjectsRoot(): string {
  return path.join(getMemorizeRoot(), "projects");
}

/**
 * Home of the personal memory store for one account — a SIBLING of
 * `projects/`, deliberately not under it, so no account's personal store
 * ever appears in `listProjects()` or a project enumeration sweep.
 *
 * The default (pre-login) account keeps the legacy flat `personal/` path
 * with no `accounts/` nesting, so existing on-disk data needs no re-keying
 * (#155). Every other account gets its own `accounts/<id>/personal/`,
 * matching the per-account id family `getPersonalStoreId` already mints
 * (`domain/identity/personal-store.ts`) — see #155 for why routing every
 * `personal_*` id to one shared directory was a bug: two distinct accounts'
 * personal stores aliased the same `mori.db`, so whichever account's id
 * opened it last decided which rows read back as "self".
 */
export function getPersonalRoot(accountId: string = DEFAULT_ACCOUNT_ID): string {
  const root = getMemorizeRoot();
  if (isDefaultAccount(accountId)) {
    return path.join(root, "personal");
  }
  return ensureWithinRoot(path.join(root, "accounts", accountId, "personal"), root);
}

export function getProjectRoot(projectId: string): string {
  assertValidId(projectId, "projectId");
  // Every derived path (db file, sync, topics, locks) flows through here, so
  // routing a personal-store id to its OWN account's root (not a single
  // shared one — #155) isolates the whole store with no other change.
  if (isPersonalStoreId(projectId)) {
    return getPersonalRoot(accountOfPersonalStore(projectId));
  }
  const projectsRoot = getProjectsRoot();
  return ensureWithinRoot(path.join(projectsRoot, projectId), projectsRoot);
}

export function getProjectDbFile(projectId: string): string {
  const projectRoot = getProjectRoot(projectId);
  return ensureWithinRoot(path.join(projectRoot, "mori.db"), projectRoot);
}

export function getTopicsDir(projectId: string): string {
  const projectRoot = getProjectRoot(projectId);
  return ensureWithinRoot(path.join(projectRoot, "topics"), projectRoot);
}

export function getTopicFile(projectId: string, topicId: string): string {
  assertValidId(topicId, "topicId");
  const topicsDir = getTopicsDir(projectId);
  return ensureWithinRoot(path.join(topicsDir, `${topicId}.md`), topicsDir);
}

export function getSyncFile(projectId: string): string {
  const projectRoot = getProjectRoot(projectId);
  return ensureWithinRoot(path.join(projectRoot, "sync", "remote.json"), projectRoot);
}

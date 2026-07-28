import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getMemorizeRoot,
  getPersonalRoot,
  getProjectDbFile,
  getProjectRoot,
  getProjectsRoot,
} from '../../src/storage/path-resolver.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mori-pathres-'));
  process.env.MEMORIZE_ROOT = root;
});

afterEach(() => {
  delete process.env.MEMORIZE_ROOT;
  rmSync(root, { recursive: true, force: true });
});

// Ported from memorize's path-resolver-account.test.ts. memorize scopes every
// store under `accounts/<accountId>/` because it supports multiple local
// accounts; mori has no CLI account concept, so #18 collapsed that whole
// layer into a single root (see PR body). These cases now just pin down that
// there is no more account-scoped nesting.
describe('path-resolver root layer (account nesting collapsed)', () => {
  it('composes roots directly under the mori root, with no accounts/<id>/ nesting', () => {
    expect(getMemorizeRoot()).toBe(root);
    expect(getProjectsRoot()).toBe(join(root, 'projects'));
    expect(getPersonalRoot()).toBe(join(root, 'personal'));
  });

  it('routes a plain project under the single projects root', () => {
    expect(getProjectRoot('proj_abc')).toBe(join(root, 'projects', 'proj_abc'));
    expect(getProjectDbFile('proj_abc')).toBe(
      join(root, 'projects', 'proj_abc', 'mori.db'),
    );
  });

  it('routes any personal-store id to the single personal root', () => {
    expect(getProjectRoot('personal_self')).toBe(join(root, 'personal'));
    // memorize's personal_<accountId> family still parses as a personal-store
    // id (domain/identity/personal-store.ts is unchanged), but with no
    // account concept there is nowhere else for it to go — it lands in the
    // same single personal root as personal_self.
    expect(getProjectRoot('personal_acc_abc')).toBe(join(root, 'personal'));
  });

  it('MEMORIZE_ROOT overrides the default root for every derived path', () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'mori-pathres-other-'));
    try {
      process.env.MEMORIZE_ROOT = otherRoot;
      expect(getMemorizeRoot()).toBe(otherRoot);
      expect(getProjectsRoot()).toBe(join(otherRoot, 'projects'));
      expect(getPersonalRoot()).toBe(join(otherRoot, 'personal'));
    } finally {
      process.env.MEMORIZE_ROOT = root;
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});

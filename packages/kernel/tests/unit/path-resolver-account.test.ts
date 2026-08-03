import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getMemorizeRoot,
  getPersonalRoot,
  getProjectDbFile,
  getProjectRoot,
  getProjectsRoot,
} from "../../src/storage/path-resolver.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mori-pathres-"));
  process.env.MEMORIZE_ROOT = root;
});

afterEach(() => {
  delete process.env.MEMORIZE_ROOT;
  rmSync(root, { recursive: true, force: true });
});

// Ported from memorize's path-resolver-account.test.ts. memorize scopes every
// store under `accounts/<accountId>/` because it supports multiple local
// accounts; mori has no CLI account concept for PROJECT stores, so #18
// collapsed that layer for `projects/` (see PR body). Personal stores are the
// exception: #155 reinstated per-account nesting for them once
// `getPersonalStoreId` started minting one id per account — see that issue
// for why aliasing every account's personal store to one shared directory
// was a bug.
describe("path-resolver root layer", () => {
  it("composes roots directly under the mori root, with no accounts/<id>/ nesting for projects", () => {
    expect(getMemorizeRoot()).toBe(root);
    expect(getProjectsRoot()).toBe(join(root, "projects"));
    expect(getPersonalRoot()).toBe(join(root, "personal"));
  });

  it("routes a plain project under the single projects root", () => {
    expect(getProjectRoot("proj_abc")).toBe(join(root, "projects", "proj_abc"));
    expect(getProjectDbFile("proj_abc")).toBe(join(root, "projects", "proj_abc", "mori.db"));
  });

  it("routes the default account's personal-store id to the legacy flat root", () => {
    expect(getProjectRoot("personal_self")).toBe(join(root, "personal"));
  });

  it("routes a non-default account's personal-store id to its own accounts/<id>/personal root", () => {
    expect(getProjectRoot("personal_acc_abc")).toBe(join(root, "accounts", "acc_abc", "personal"));
    // distinct accounts get distinct, non-aliasing roots
    expect(getProjectRoot("personal_acc_xyz")).not.toBe(getProjectRoot("personal_acc_abc"));
  });

  it("MEMORIZE_ROOT overrides the default root for every derived path", () => {
    const otherRoot = mkdtempSync(join(tmpdir(), "mori-pathres-other-"));
    try {
      process.env.MEMORIZE_ROOT = otherRoot;
      expect(getMemorizeRoot()).toBe(otherRoot);
      expect(getProjectsRoot()).toBe(join(otherRoot, "projects"));
      expect(getPersonalRoot()).toBe(join(otherRoot, "personal"));
    } finally {
      process.env.MEMORIZE_ROOT = root;
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});

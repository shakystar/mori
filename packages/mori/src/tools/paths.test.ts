import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWithinRoot } from "./paths.js";

describe("resolveWithinRoot", () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "mori-paths-"));
    root = join(base, "root");
    mkdirSync(root);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("resolves a normal path inside the root", () => {
    writeFileSync(join(root, "file.txt"), "hello");

    const result = resolveWithinRoot(root, "file.txt");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved).toBe(join(realpathSync(root), "file.txt"));
  });

  it("resolves nested subdirectories", () => {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "file.txt"), "hello");

    const result = resolveWithinRoot(root, "sub/file.txt");

    expect(result.ok).toBe(true);
  });

  it("blocks a relative .. escape", () => {
    writeFileSync(join(base, "secret.txt"), "top secret");

    const result = resolveWithinRoot(root, "../secret.txt");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/escapes working root/);
  });

  it("blocks an absolute path outside the root", () => {
    const outside = join(base, "outside.txt");
    writeFileSync(outside, "nope");

    const result = resolveWithinRoot(root, outside);

    expect(result.ok).toBe(false);
  });

  it("blocks a symlink that points outside the root", () => {
    const outsideDir = join(base, "outside");
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "target.txt"), "nope");
    symlinkSync(outsideDir, join(root, "escape"));

    const result = resolveWithinRoot(root, "escape/target.txt");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/escapes working root/);
  });

  it("blocks a symlinked ancestor escape for a not-yet-existing write target", () => {
    const outsideDir = join(base, "outside");
    mkdirSync(outsideDir);
    symlinkSync(outsideDir, join(root, "escape"));

    const result = resolveWithinRoot(root, "escape/new-file.txt");

    expect(result.ok).toBe(false);
  });

  it("blocks a dangling symlink pointing at a not-yet-existing location outside the root", () => {
    const outsideDir = join(base, "outside");
    mkdirSync(outsideDir);
    // The symlink target (outsideDir/not-yet-there) does not exist yet.
    symlinkSync(join(outsideDir, "not-yet-there"), join(root, "escape"));

    const result = resolveWithinRoot(root, "escape");

    expect(result.ok).toBe(false);
  });

  it("does not let a sibling directory that merely shares a prefix through", () => {
    const evilSibling = `${root}-evil`;
    mkdirSync(evilSibling);
    writeFileSync(join(evilSibling, "secret.txt"), "nope");

    const result = resolveWithinRoot(root, join("..", "root-evil", "secret.txt"));

    expect(result.ok).toBe(false);
  });

  it("reports failure without throwing when the root itself does not exist", () => {
    expect(() => resolveWithinRoot(join(base, "does-not-exist"), "file.txt")).not.toThrow();
    const result = resolveWithinRoot(join(base, "does-not-exist"), "file.txt");
    expect(result.ok).toBe(false);
  });
});

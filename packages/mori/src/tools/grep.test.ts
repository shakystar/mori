import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GREP_MAX_MATCHES, grep } from "./grep.js";
import { resolveWithinRoot } from "./paths.js";
import { readFile } from "./read-file.js";

// mori#124 regression: `realpathSync` is a non-configurable ESM named export, so it
// can't be `vi.spyOn`'d directly — wrapping it via a partial `vi.mock` is the only way
// to count calls into it while still delegating to the real implementation.
const realpathCalls = vi.fn();
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    realpathSync: (path: Parameters<typeof actual.realpathSync>[0]) => {
      realpathCalls(path);
      return actual.realpathSync(path);
    },
  };
});

describe("grep", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mori-grep-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds fixed-string matches with file:line:content formatting", () => {
    writeFileSync(join(root, "a.txt"), "hello\nneedle here\nworld");

    const result = grep(root, "needle");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matches).toEqual([{ file: "a.txt", line: 2, text: "needle here" }]);
      expect(result.truncated).toBe(false);
    }
  });

  it("supports regex matching", () => {
    writeFileSync(join(root, "a.txt"), "foo123\nbar\nfoo456");

    const result = grep(root, "foo\\d+", { regex: true });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.matches).toHaveLength(2);
  });

  it("returns a structured failure, not a throw, for an invalid regex", () => {
    expect(() => grep(root, "(unterminated", { regex: true })).not.toThrow();

    const result = grep(root, "(unterminated", { regex: true });

    expect(result.ok).toBe(false);
  });

  it("skips node_modules, .git, and dist", () => {
    for (const dir of ["node_modules", ".git", "dist", "src"]) {
      mkdirSync(join(root, dir));
      writeFileSync(join(root, dir, "file.txt"), "needle");
    }

    const result = grep(root, "needle");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matches).toEqual([{ file: join("src", "file.txt"), line: 1, text: "needle" }]);
    }
  });

  it("truncates once the match cap is reached", () => {
    const lines = Array.from({ length: GREP_MAX_MATCHES + 20 }, () => "needle").join("\n");
    writeFileSync(join(root, "big.txt"), lines);

    const result = grep(root, "needle");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.truncated).toBe(true);
      expect(result.matches).toHaveLength(GREP_MAX_MATCHES);
    }
  });

  it("relativizes matches using the guard's realRoot instead of independently re-resolving root", () => {
    // mori#124: grep used to call realpathSync(root) a second time to relativize
    // matches, instead of reusing resolveWithinRoot's own realRoot. Asserting the
    // realpathSync call count matches what the guard alone performs (rather than
    // reproducing the race itself, which isn't deterministic) pins the fix in place —
    // a regression back to a second, independent resolution would add a call here.
    writeFileSync(join(root, "a.txt"), "needle here");

    realpathCalls.mockClear();
    resolveWithinRoot(root, ".");
    const guardCallCount = realpathCalls.mock.calls.length;
    realpathCalls.mockClear();

    const result = grep(root, "needle");

    expect(result.ok).toBe(true);
    expect(realpathCalls).toHaveBeenCalledTimes(guardCallCount);
  });

  it("returns a structured failure for a search path escaping the root", () => {
    const result = grep(root, "needle", { path: ".." });

    expect(result.ok).toBe(false);
  });

  it("returns root-relative paths, not ../.. escapes, when the working root is reached through a symlink", () => {
    // Regression for #83: `root` used to be relativized against the caller-supplied path,
    // but matched files are found via resolveWithinRoot's realpath'd path — a mismatch
    // whenever `root` itself sits behind a symlink. Ubuntu CI's `/tmp` is a real directory
    // (unlike macOS, where it's `/private/tmp`), so this never failed there; building an
    // explicit symlinked root here reproduces it deterministically on any OS/CI.
    const base = mkdtempSync(join(tmpdir(), "mori-grep-symlink-"));
    try {
      const realRoot = join(base, "real-root");
      mkdirSync(realRoot);
      writeFileSync(join(realRoot, "needle.txt"), "needle here");
      const linkedRoot = join(base, "linked-root");
      symlinkSync(realRoot, linkedRoot);

      const result = grep(linkedRoot, "needle");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.matches).toEqual([{ file: "needle.txt", line: 1, text: "needle here" }]);

      // The path grep hands back must be directly usable by read_file against the same
      // root — this round trip is the actual contract the production bug violated.
      const readBack = readFile(linkedRoot, result.matches[0]!.file);
      expect(readBack.ok).toBe(true);
      if (readBack.ok) expect(readBack.content).toBe("needle here");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GREP_MAX_MATCHES, grep } from "./grep.js";

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

  it("returns a structured failure for a search path escaping the root", () => {
    const result = grep(root, "needle", { path: ".." });

    expect(result.ok).toBe(false);
  });
});

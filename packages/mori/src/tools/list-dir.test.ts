import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIST_DIR_MAX_ENTRIES, listDir } from "./list-dir.js";

describe("listDir", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mori-list-dir-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lists files and directories with their types", () => {
    writeFileSync(join(root, "a.txt"), "a");
    mkdirSync(join(root, "sub"));

    const result = listDir(root, ".");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toEqual([
        { name: "a.txt", type: "file" },
        { name: "sub", type: "directory" },
      ]);
      expect(result.truncated).toBe(false);
    }
  });

  it("returns a structured failure, not a throw, for a missing directory", () => {
    expect(() => listDir(root, "missing")).not.toThrow();

    const result = listDir(root, "missing");

    expect(result.ok).toBe(false);
  });

  it("returns a structured failure for a file path", () => {
    writeFileSync(join(root, "file.txt"), "hi");

    const result = listDir(root, "file.txt");

    expect(result.ok).toBe(false);
  });

  it("returns a structured failure for a path escaping the root", () => {
    const result = listDir(root, "..");

    expect(result.ok).toBe(false);
  });

  it("truncates directories with more entries than the cap", () => {
    for (let i = 0; i < LIST_DIR_MAX_ENTRIES + 20; i++) {
      writeFileSync(join(root, `file-${String(i).padStart(5, "0")}.txt`), "x");
    }

    const result = listDir(root, ".");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.truncated).toBe(true);
      expect(result.totalEntries).toBe(LIST_DIR_MAX_ENTRIES + 20);
      expect(result.entries).toHaveLength(LIST_DIR_MAX_ENTRIES);
    }
  });
});

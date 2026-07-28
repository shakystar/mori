import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadFileTool, READ_FILE_MAX_LINES, readFile } from "./read-file.js";

describe("readFile", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mori-read-file-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns the contents of a file inside the root", () => {
    writeFileSync(join(root, "hello.txt"), "hello world");

    const result = readFile(root, "hello.txt");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe("hello world");
      expect(result.truncated).toBe(false);
    }
  });

  it("returns a structured failure, not a throw, for a missing file", () => {
    expect(() => readFile(root, "missing.txt")).not.toThrow();

    const result = readFile(root, "missing.txt");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not found/);
  });

  it("returns a structured failure for a directory path", () => {
    mkdirSync(join(root, "adir"));

    const result = readFile(root, "adir");

    expect(result.ok).toBe(false);
  });

  it("returns a structured failure, not a throw, for a path escaping the root", () => {
    const sibling = mkdtempSync(join(tmpdir(), "mori-read-file-sibling-"));
    writeFileSync(join(sibling, "outside.txt"), "nope");

    const result = readFile(root, join("..", basename(sibling), "outside.txt"));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/escapes working root/);
    rmSync(sibling, { recursive: true, force: true });
  });

  it("blocks reading through a symlink that escapes the root", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "mori-read-file-outside-"));
    writeFileSync(join(outsideDir, "secret.txt"), "nope");
    symlinkSync(outsideDir, join(root, "escape"));

    const result = readFile(root, "escape/secret.txt");

    expect(result.ok).toBe(false);
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("truncates files longer than the line cap and reports the truncation", () => {
    const lines = Array.from({ length: READ_FILE_MAX_LINES + 50 }, (_, i) => `line ${i}`);
    writeFileSync(join(root, "big.txt"), lines.join("\n"));

    const result = readFile(root, "big.txt");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.truncated).toBe(true);
      expect(result.totalLines).toBe(lines.length);
      expect(result.content.split("\n")).toHaveLength(READ_FILE_MAX_LINES);
    }
  });

  it("rejects binary content instead of returning garbage", () => {
    writeFileSync(join(root, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 5]));

    const result = readFile(root, "bin.dat");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/binary/);
  });
});

describe("createReadFileTool", () => {
  it("never throws for a blocked path and surfaces the reason to the model", async () => {
    const root = mkdtempSync(join(tmpdir(), "mori-read-file-tool-"));
    const tool = createReadFileTool(root);

    const result = await tool.execute("call-1", { path: "../etc/passwd" });

    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { type: "text"; text: string }).text).toMatch(/^Error:/);
    expect(result.details.ok).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });
});

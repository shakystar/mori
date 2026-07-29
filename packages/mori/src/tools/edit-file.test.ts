import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditFileTool, editFile } from "./edit-file.js";

describe("editFile", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mori-edit-file-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("replaces a uniquely matching oldString", () => {
    writeFileSync(join(root, "file.txt"), "hello world");

    const result = editFile(root, "file.txt", "world", "there");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.replacements).toBe(1);
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("hello there");
  });

  it("fails without changing the file when oldString has zero matches", () => {
    writeFileSync(join(root, "file.txt"), "hello world");

    const result = editFile(root, "file.txt", "goodbye", "hi");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not found/);
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("hello world");
  });

  it("fails without changing the file when oldString matches more than once", () => {
    writeFileSync(join(root, "file.txt"), "a b a");

    const result = editFile(root, "file.txt", "a", "x");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/matches 2 times/);
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("a b a");
  });

  it("replaces every occurrence when replaceAll is set", () => {
    writeFileSync(join(root, "file.txt"), "a b a");

    const result = editFile(root, "file.txt", "a", "x", true);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.replacements).toBe(2);
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("x b x");
  });

  it("rejects oldString === newString", () => {
    writeFileSync(join(root, "file.txt"), "hello world");

    const result = editFile(root, "file.txt", "world", "world");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/identical/);
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("hello world");
  });

  it("creates a new file when oldString is empty and the file doesn't exist", () => {
    const result = editFile(root, "new.txt", "", "brand new content");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.created).toBe(true);
      expect(result.replacements).toBe(0);
    }
    expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("brand new content");
  });

  it("rejects an empty oldString when the file already exists", () => {
    writeFileSync(join(root, "file.txt"), "hello world");

    const result = editFile(root, "file.txt", "", "replacement");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/already exists/);
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("hello world");
  });

  it("blocks a path escaping the root and does not create or change any file", () => {
    const sibling = mkdtempSync(join(tmpdir(), "mori-edit-file-sibling-"));

    const result = editFile(
      root,
      join("..", basename(sibling), "outside.txt"),
      "",
      "malicious content",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/escapes working root/);
    expect(readdirSync(sibling)).toHaveLength(0);
    rmSync(sibling, { recursive: true, force: true });
  });

  it("blocks writing through a dangling symlink pointing outside the root", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "mori-edit-file-outside-"));
    symlinkSync(join(outsideDir, "not-yet-there"), join(root, "escape"));

    const result = editFile(root, "escape", "", "malicious content");

    expect(result.ok).toBe(false);
    expect(readdirSync(outsideDir)).toHaveLength(0);
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("returns a structured failure, not a throw, for a directory path", () => {
    mkdirSync(join(root, "adir"));

    expect(() => editFile(root, "adir", "x", "y")).not.toThrow();
    const result = editFile(root, "adir", "x", "y");

    expect(result.ok).toBe(false);
  });

  it("does not leave a temp file behind after a successful edit", () => {
    writeFileSync(join(root, "file.txt"), "hello world");

    editFile(root, "file.txt", "world", "there");

    expect(readdirSync(root)).toEqual(["file.txt"]);
  });

  it("preserves the existing file's permissions after an edit", () => {
    const path = join(root, "file.txt");
    writeFileSync(path, "hello world");
    chmodSync(path, 0o600);

    const result = editFile(root, "file.txt", "world", "there");

    expect(result.ok).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("createEditFileTool", () => {
  it("never throws for a blocked path and surfaces the reason to the model", async () => {
    const root = mkdtempSync(join(tmpdir(), "mori-edit-file-tool-"));
    const tool = createEditFileTool(root);

    const result = await tool.execute("call-1", {
      path: "../etc/passwd",
      oldString: "",
      newString: "pwned",
    });

    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { type: "text"; text: string }).text).toMatch(/^Error:/);
    expect(result.details.ok).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  it("reports the replacement count for a successful edit", async () => {
    const root = mkdtempSync(join(tmpdir(), "mori-edit-file-tool-"));
    writeFileSync(join(root, "file.txt"), "hello world");
    const tool = createEditFileTool(root);

    const result = await tool.execute("call-1", {
      path: "file.txt",
      oldString: "world",
      newString: "there",
    });

    expect((result.content[0] as { type: "text"; text: string }).text).toMatch(
      /Replaced 1 occurrence/,
    );
    expect(result.details.ok).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });
});

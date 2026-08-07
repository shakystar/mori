import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolveWithinRoot, type Failure } from "./paths.js";
import { errorResult, textResult } from "./tool-result.js";

export interface EditFileSuccess {
  ok: true;
  path: string;
  created: boolean;
  replacements: number;
}

export type EditFileFailure = Failure;

export type EditFileResult = EditFileSuccess | EditFileFailure;

/**
 * Replaces `oldString` with `newString` in the file at `requestedPath`, using exact
 * (non-regex) string matching.
 *
 * - `oldString` must match exactly once, unless `replaceAll` is set — this makes an
 *   accidentally ambiguous match a hard failure instead of a silent wrong edit.
 * - An empty `oldString` is only accepted when the file does not exist yet, and is
 *   treated as "create this file with `newString` as its content". An empty
 *   `oldString` against an existing file is rejected rather than doing anything with
 *   "every position matches", which has no sensible meaning here.
 * - `oldString === newString` is rejected outright since it can never be a real edit.
 *
 * Never throws: every failure is returned as a structured `{ ok: false, reason }` and
 * the file on disk is left untouched.
 */
export function editFile(
  root: string,
  requestedPath: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): EditFileResult {
  if (oldString === newString) {
    return { ok: false, reason: "oldString and newString are identical; nothing to change" };
  }

  const resolved = resolveWithinRoot(root, requestedPath);
  if (!resolved.ok) return resolved;

  let stats;
  try {
    stats = statSync(resolved.resolved);
  } catch {
    stats = undefined;
  }

  if (stats?.isDirectory()) {
    return { ok: false, reason: `path is a directory, not a file: ${requestedPath}` };
  }

  if (!stats) {
    if (oldString !== "") {
      return { ok: false, reason: `file not found: ${requestedPath}` };
    }
    if (!existsSync(dirname(resolved.resolved))) {
      return { ok: false, reason: `parent directory does not exist: ${requestedPath}` };
    }
    try {
      atomicWrite(resolved.resolved, newString);
    } catch (error) {
      return {
        ok: false,
        reason: `failed to write file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return { ok: true, path: requestedPath, created: true, replacements: 0 };
  }

  if (oldString === "") {
    return { ok: false, reason: `file already exists: ${requestedPath}` };
  }

  let content: string;
  try {
    content = readFileSync(resolved.resolved, "utf8");
  } catch (error) {
    return {
      ok: false,
      reason: `failed to read file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const matches = countOccurrences(content, oldString);

  if (matches === 0) {
    return { ok: false, reason: `oldString not found in file: ${requestedPath}` };
  }

  if (matches > 1 && !replaceAll) {
    return {
      ok: false,
      reason: `oldString matches ${matches} times in ${requestedPath}; pass replaceAll to replace every occurrence`,
    };
  }

  const updated = replaceAll
    ? content.split(oldString).join(newString)
    : replaceOnce(content, oldString, newString);

  try {
    atomicWrite(resolved.resolved, updated, stats.mode);
  } catch (error) {
    return {
      ok: false,
      reason: `failed to write file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return { ok: true, path: requestedPath, created: false, replacements: replaceAll ? matches : 1 };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
}

function replaceOnce(haystack: string, needle: string, replacement: string): string {
  const at = haystack.indexOf(needle);
  return haystack.slice(0, at) + replacement + haystack.slice(at + needle.length);
}

/**
 * Writes `content` to `targetPath` atomically: a temp file is written in the same
 * directory, its mode is set to match the original file (if given), and it's
 * `rename`d into place. `rename` within one directory is a single filesystem
 * operation, so a crash mid-write never leaves `targetPath` truncated or partial —
 * readers either see the old content or the new content, never a mix.
 */
function atomicWrite(targetPath: string, content: string, mode?: number): void {
  const tempPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${randomBytes(6).toString("hex")}.mori-tmp`,
  );
  try {
    writeFileSync(tempPath, content, "utf8");
    if (mode !== undefined) chmodSync(tempPath, mode);
    renameSync(tempPath, targetPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // best-effort cleanup of the temp file; the original error is what matters
    }
    throw error;
  }
}

const editFileParameters = Type.Object({
  path: Type.String({ description: "File path, relative to the working root." }),
  oldString: Type.String({
    description:
      "Exact text to find and replace. Must match exactly once in the file unless replaceAll is set. " +
      "Pass an empty string to create a new file (only valid when the file doesn't already exist).",
  }),
  newString: Type.String({
    description: "Text to replace oldString with. Must differ from oldString.",
  }),
  replaceAll: Type.Optional(
    Type.Boolean({
      description:
        "Replace every occurrence of oldString instead of requiring exactly one match. Defaults to false.",
      default: false,
    }),
  ),
});

export function createEditFileTool(
  root: string = process.cwd(),
): AgentTool<typeof editFileParameters, EditFileResult> {
  return {
    name: "edit_file",
    label: "Edit File",
    description:
      "Replaces an exact, unique occurrence of oldString with newString in a text file within the working root. " +
      "Fails without changing the file if oldString doesn't match exactly once (pass replaceAll to replace every " +
      "occurrence instead). To create a new file, pass an empty oldString for a path that doesn't exist yet.",
    parameters: editFileParameters,
    // Performs its own read-modify-write cycle with no isolation; running it concurrently
    // with another tool call risks racing on the same file. See bash.ts's executionMode
    // comment — same flag, and since #381 the only thing carrying sequential execution.
    executionMode: "sequential",
    execute: async (_toolCallId, params: Static<typeof editFileParameters>) => {
      const result = editFile(
        root,
        params.path,
        params.oldString,
        params.newString,
        params.replaceAll ?? false,
      );
      if (!result.ok) return errorResult(result);

      const text = result.created
        ? `Created ${result.path}`
        : `Replaced ${result.replacements} occurrence${result.replacements === 1 ? "" : "s"} in ${result.path}`;

      return textResult(text, result);
    },
  };
}

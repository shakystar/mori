import { readFileSync, statSync } from "node:fs";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolveWithinRoot } from "./paths.js";

/** Output cap: files past this many lines are truncated. */
export const READ_FILE_MAX_LINES = 2000;
/** Files larger than this on disk are rejected outright instead of being read into memory. */
export const READ_FILE_MAX_BYTES = 1_000_000;

export interface ReadFileSuccess {
  ok: true;
  path: string;
  content: string;
  truncated: boolean;
  totalLines: number;
}

export interface ReadFileFailure {
  ok: false;
  reason: string;
}

export type ReadFileResult = ReadFileSuccess | ReadFileFailure;

export function readFile(root: string, requestedPath: string): ReadFileResult {
  const resolved = resolveWithinRoot(root, requestedPath);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  let stats;
  try {
    stats = statSync(resolved.resolved);
  } catch {
    return { ok: false, reason: `file not found: ${requestedPath}` };
  }

  if (stats.isDirectory()) {
    return { ok: false, reason: `path is a directory, not a file: ${requestedPath}` };
  }

  if (stats.size > READ_FILE_MAX_BYTES) {
    return {
      ok: false,
      reason: `file too large to read: ${requestedPath} (${stats.size} bytes, limit ${READ_FILE_MAX_BYTES})`,
    };
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(resolved.resolved);
  } catch (error) {
    return {
      ok: false,
      reason: `failed to read file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (isBinary(buffer)) {
    return { ok: false, reason: `file appears to be binary: ${requestedPath}` };
  }

  const text = buffer.toString("utf8");
  const lines = text.split("\n");
  const truncated = lines.length > READ_FILE_MAX_LINES;
  const content = truncated ? lines.slice(0, READ_FILE_MAX_LINES).join("\n") : text;

  return { ok: true, path: requestedPath, content, truncated, totalLines: lines.length };
}

function isBinary(buffer: Buffer): boolean {
  const sampleSize = Math.min(buffer.length, 8000);
  for (let i = 0; i < sampleSize; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

const readFileParameters = Type.Object({
  path: Type.String({ description: "File path, relative to the working root." }),
});

export function createReadFileTool(
  root: string = process.cwd(),
): AgentTool<typeof readFileParameters, ReadFileResult> {
  return {
    name: "read_file",
    label: "Read File",
    description: "Reads the contents of a text file within the working root.",
    parameters: readFileParameters,
    execute: async (_toolCallId, params: Static<typeof readFileParameters>) => {
      const result = readFile(root, params.path);

      if (!result.ok) {
        return { content: [{ type: "text", text: `Error: ${result.reason}` }], details: result };
      }

      const notice = result.truncated
        ? `\n\n[truncated: showing first ${READ_FILE_MAX_LINES} of ${result.totalLines} lines]`
        : "";

      return { content: [{ type: "text", text: result.content + notice }], details: result };
    },
  };
}

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolveWithinRoot } from "./paths.js";

/** Match cap: searches stop early once this many matches are collected. */
export const GREP_MAX_MATCHES = 500;
/** Files larger than this are skipped during the walk. */
export const GREP_MAX_FILE_BYTES = 1_000_000;

const EXCLUDED_DIR_NAMES = new Set(["node_modules", ".git", "dist"]);

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

export interface GrepSuccess {
  ok: true;
  matches: GrepMatch[];
  truncated: boolean;
}

export interface GrepFailure {
  ok: false;
  reason: string;
}

export type GrepResult = GrepSuccess | GrepFailure;

export interface GrepOptions {
  /** Subdirectory (or file) to scope the search to, relative to root. Defaults to the whole root. */
  path?: string;
  /** Treat `pattern` as a regular expression instead of a fixed string. */
  regex?: boolean;
}

export function grep(root: string, pattern: string, options: GrepOptions = {}): GrepResult {
  const scopePath = options.path ?? ".";
  const resolved = resolveWithinRoot(root, scopePath);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  let matcher: (line: string) => boolean;
  if (options.regex) {
    let compiled: RegExp;
    try {
      compiled = new RegExp(pattern);
    } catch (error) {
      return {
        ok: false,
        reason: `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    matcher = (line) => compiled.test(line);
  } else {
    matcher = (line) => line.includes(pattern);
  }

  let scopeStats;
  try {
    scopeStats = statSync(resolved.resolved);
  } catch {
    return { ok: false, reason: `path not found: ${scopePath}` };
  }

  const matches: GrepMatch[] = [];
  let truncated = false;

  const searchFile = (filePath: string): void => {
    let stats;
    try {
      stats = statSync(filePath);
    } catch {
      return;
    }
    if (stats.size > GREP_MAX_FILE_BYTES) return;

    let buffer: Buffer;
    try {
      buffer = readFileSync(filePath);
    } catch {
      return;
    }
    if (isBinary(buffer)) return;

    const lines = buffer.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= GREP_MAX_MATCHES) {
        truncated = true;
        return;
      }
      if (matcher(lines[i])) {
        matches.push({ file: relative(root, filePath), line: i + 1, text: lines[i] });
      }
    }
  };

  const visit = (dir: string): void => {
    if (truncated) return;
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (truncated) return;
      if (dirent.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(dirent.name)) continue;
        visit(join(dir, dirent.name));
      } else if (dirent.isFile()) {
        searchFile(join(dir, dirent.name));
      }
    }
  };

  if (scopeStats.isDirectory()) {
    visit(resolved.resolved);
  } else if (scopeStats.isFile()) {
    searchFile(resolved.resolved);
  }

  return { ok: true, matches, truncated };
}

function isBinary(buffer: Buffer): boolean {
  const sampleSize = Math.min(buffer.length, 8000);
  for (let i = 0; i < sampleSize; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

const grepParameters = Type.Object({
  pattern: Type.String({ description: "Fixed string (or regular expression, if regex=true) to search for." }),
  path: Type.Optional(
    Type.String({ description: "Subdirectory or file to search, relative to the working root. Defaults to the whole root." }),
  ),
  regex: Type.Optional(Type.Boolean({ description: "Treat `pattern` as a regular expression. Defaults to false." })),
});

export function createGrepTool(root: string = process.cwd()): AgentTool<typeof grepParameters, GrepResult> {
  return {
    name: "grep",
    label: "Search Files",
    description:
      "Recursively searches text files under the working root for a fixed string or regular expression. " +
      "Skips node_modules, .git, and dist.",
    parameters: grepParameters,
    execute: async (_toolCallId, params: Static<typeof grepParameters>) => {
      const result = grep(root, params.pattern, { path: params.path, regex: params.regex });

      if (!result.ok) {
        return { content: [{ type: "text", text: `Error: ${result.reason}` }], details: result };
      }

      const lines = result.matches.map((match) => `${match.file}:${match.line}:${match.text}`);
      const notice = result.truncated ? `\n\n[truncated: showing first ${GREP_MAX_MATCHES} matches]` : "";
      const text = lines.length > 0 ? lines.join("\n") + notice : "No matches found.";

      return { content: [{ type: "text", text }], details: result };
    },
  };
}

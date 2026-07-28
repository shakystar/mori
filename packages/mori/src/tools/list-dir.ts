import { readdirSync, statSync } from "node:fs";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolveWithinRoot } from "./paths.js";

/** Entry cap: directories with more entries than this are truncated. */
export const LIST_DIR_MAX_ENTRIES = 1000;

export interface DirEntry {
  name: string;
  type: "file" | "directory" | "other";
}

export interface ListDirSuccess {
  ok: true;
  path: string;
  entries: DirEntry[];
  truncated: boolean;
  totalEntries: number;
}

export interface ListDirFailure {
  ok: false;
  reason: string;
}

export type ListDirResult = ListDirSuccess | ListDirFailure;

export function listDir(root: string, requestedPath = "."): ListDirResult {
  const resolved = resolveWithinRoot(root, requestedPath);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  let stats;
  try {
    stats = statSync(resolved.resolved);
  } catch {
    return { ok: false, reason: `directory not found: ${requestedPath}` };
  }

  if (!stats.isDirectory()) {
    return { ok: false, reason: `path is not a directory: ${requestedPath}` };
  }

  let dirents;
  try {
    dirents = readdirSync(resolved.resolved, { withFileTypes: true });
  } catch (error) {
    return {
      ok: false,
      reason: `failed to read directory: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const entries: DirEntry[] = dirents
    .map((dirent) => ({
      name: dirent.name,
      type: (dirent.isDirectory() ? "directory" : dirent.isFile() ? "file" : "other") as DirEntry["type"],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const truncated = entries.length > LIST_DIR_MAX_ENTRIES;

  return {
    ok: true,
    path: requestedPath,
    entries: truncated ? entries.slice(0, LIST_DIR_MAX_ENTRIES) : entries,
    truncated,
    totalEntries: entries.length,
  };
}

const listDirParameters = Type.Object({
  path: Type.Optional(
    Type.String({ description: "Directory path, relative to the working root. Defaults to the root itself." }),
  ),
});

export function createListDirTool(root: string = process.cwd()): AgentTool<typeof listDirParameters, ListDirResult> {
  return {
    name: "list_dir",
    label: "List Directory",
    description: "Lists the entries (files and subdirectories) of a directory within the working root.",
    parameters: listDirParameters,
    execute: async (_toolCallId, params: Static<typeof listDirParameters>) => {
      const result = listDir(root, params.path ?? ".");

      if (!result.ok) {
        return { content: [{ type: "text", text: `Error: ${result.reason}` }], details: result };
      }

      const lines = result.entries.map((entry) => (entry.type === "directory" ? `${entry.name}/` : entry.name));
      const notice = result.truncated
        ? `\n\n[truncated: showing first ${LIST_DIR_MAX_ENTRIES} of ${result.totalEntries} entries]`
        : "";

      return { content: [{ type: "text", text: lines.join("\n") + notice }], details: result };
    },
  };
}

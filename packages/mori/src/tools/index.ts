import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createBashTool } from "./bash.js";
import { createEditFileTool } from "./edit-file.js";
import { createGrepTool } from "./grep.js";
import { createListDirTool } from "./list-dir.js";
import { createReadFileTool } from "./read-file.js";

export * from "./paths.js";
export * from "./read-file.js";
export * from "./list-dir.js";
export * from "./grep.js";
export * from "./edit-file.js";
export * from "./bash.js";

/**
 * Builds mori's default toolset: read_file, list_dir, grep, edit_file, bash.
 *
 * `root` is threaded to every tool as its working root — the same value becomes both
 * the path guard's root (read_file/list_dir/grep/edit_file) and the bash tool's child
 * cwd, so a path that the guard allows and a relative path a shell command resolves
 * agree on what "inside the working root" means.
 */
export function createMoriTools(
  root: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool<TArgs> erasure for a heterogeneous tool array
): AgentTool<any>[] {
  return [
    createReadFileTool(root),
    createListDirTool(root),
    createGrepTool(root),
    createEditFileTool(root),
    createBashTool(root, { env }),
  ];
}

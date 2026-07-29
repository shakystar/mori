import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * True when this module was invoked as the process entrypoint (`node index.js`, or via a
 * `bin` symlink), as opposed to being imported for its exports (e.g. `index.test.ts`
 * importing `runCli` directly). Resolving the symlink through `realpathSync` is what makes
 * this work for the installed `mori` bin, which npm/pnpm links into `node_modules/.bin`.
 */
export function isMainEntry(entry: string | undefined, moduleUrl: string): boolean {
  return Boolean(entry) && moduleUrl === pathToFileURL(realpathSync(entry as string)).href;
}

import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// Regression test for the bin entrypoint guard in index.ts: `pnpm build` lays
// `dist/index.js` down as the package's `bin` target, and npm/pnpm install it
// via a symlink (node_modules/.bin/mori, or a global bin dir). Calling
// `runCli` directly (as index.test.ts does) can never catch a guard that only
// misbehaves through that symlink indirection, so this spawns the built
// artifact through a symlink the same way a real install would.
//
// Requires `dist/index.js` to exist, i.e. run `pnpm build` before this test
// (the root `pretest` script does this automatically for `pnpm test`).

const distEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

describe("bin entrypoint via symlink", () => {
  let tmpDir: string;

  beforeAll(() => {
    if (!existsSync(distEntry)) {
      throw new Error(
        `dist/index.js not found at ${distEntry} — run \`pnpm build\` before \`pnpm test\`.`,
      );
    }
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("still runs the guarded CLI body when invoked through a bin-style symlink", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mori-bin-"));
    const link = join(tmpDir, "mori");
    symlinkSync(distEntry, link);

    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const result = spawnSync(process.execPath, [link, "hi"], { env, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ANTHROPIC_API_KEY");
  });
});

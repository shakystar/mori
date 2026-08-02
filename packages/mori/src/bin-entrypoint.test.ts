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

  // Explicit timeout, not vitest's inherited 5000ms default (#147). This test spawns a real
  // Node process and waits for it synchronously, so it was riding vitest's generic-unit-test
  // budget with near-zero margin. Measured on this host: 15 isolated back-to-back spawns (no
  // other load) landed a ~400-500ms baseline but tailed up to ~6.8s. Instrumenting the spawned
  // process showed that spike sits almost entirely *before* its own first line of source runs
  // (Node's process bootstrap / ESM loader), not in resolving mori's own import graph — from
  // that first line to entering `runCli` was consistently <1-100ms. So the module graph isn't
  // the lever here; there's no in-repo cost left to trim, and shrinking it wouldn't move this
  // number. 30000ms is ~4.4x the worst isolated tail observed, leaving headroom for the extra
  // contention of running inside the full parallel suite.
  it(
    "still runs the guarded CLI body when invoked through a bin-style symlink",
    { timeout: 30000 },
    () => {
      tmpDir = mkdtempSync(join(tmpdir(), "mori-bin-"));
      const link = join(tmpDir, "mori");
      symlinkSync(distEntry, link);

      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;

      const result = spawnSync(process.execPath, [link, "hi"], { env, encoding: "utf8" });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ANTHROPIC_API_KEY");
    },
  );
});

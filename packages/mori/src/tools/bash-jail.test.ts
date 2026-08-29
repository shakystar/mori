import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBash } from "./bash.js";

/**
 * mori#489 regression coverage for `RunBashOptions.confineWrites`.
 *
 * One behavior is under test: a shell-mediated write outside the working root fails.
 * The bypass techniques the boundary has to survive (`node -e`, `../`, symlinks, nested
 * namespaces, `remount,rw`) are deliberately *not* one case each — they all take the
 * same code path to the same failure mode (`EROFS` from the VFS), so a case per
 * technique would be the "기존 케이스의 사소한 변형 중복" TESTING.md forbids. They are
 * enumerated, with what each was observed to do, in `bash-jail.ts`'s module comment.
 * The escape here is written as `node -e` because that is the exact form the mori#489
 * incident used against `/data/repos/mori`.
 *
 * The second case is not a variation of the first: a jail that failed every command
 * would pass the first case, so this pins that confinement does not break legitimate
 * work inside the root.
 *
 * Linux-only, and not skipped when `unshare` is unavailable — an image that cannot run
 * the jail is the fact these tests exist to surface, not one to look away from. The
 * suite already assumes a Linux host elsewhere (`/bin/bash`, `/proc`; see TESTING.md).
 */

let root: string;
let outside: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "mori-bash-jail-root-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "mori-bash-jail-outside-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("runBash confineWrites", () => {
  it("fails a command that writes outside the working root, and leaves the file uncreated", async () => {
    const target = join(outside, "escaped.txt");
    const command = `${process.execPath} -e 'require("fs").writeFileSync(process.argv[1], "x")' ${target}`;

    const result = await runBash(command, { root, confineWrites: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it("still runs a command that writes inside the working root", async () => {
    const result = await runBash("echo hi > inside.txt && cat inside.txt", {
      root,
      confineWrites: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi\n");
  });
});

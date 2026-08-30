/**
 * Kernel-enforced write confinement for the `bash` tool (mori#489).
 *
 * `bash.ts`'s module comment already explains why a command-string guard (the approach
 * `bash-guard.ts` uses for destructive patterns) cannot be extended to "stay inside the
 * working root": the guard would have to parse shell syntax, and `cat ../../etc/passwd`,
 * `node -e "fs.writeFileSync('/etc/passwd', ...)"`, and a symlink planted earlier in the
 * same session are three different ways to reach the same path with nothing in common
 * for a string matcher to key on. mori#489 is exactly this: a bench episode's model used
 * `bash` to edit files under `/data/repos/mori` — the real checkout, not its scratch
 * working root — because nothing below the shell layer disagreed.
 *
 * This module does not add another guard of that kind. It puts the write boundary where
 * the model's command string cannot see it: a private Linux mount namespace
 * (`unshare --user --mount`) in which every mount point *except* the working root is
 * remounted read-only before the command ever runs. `node -e`, a symlink, `sh -c`, a
 * relative `../` — none of them are a *path string a matcher missed*, they are a
 * `write()` syscall the kernel VFS layer refuses regardless of which process issued it
 * or how it built the path, because the mount underneath every one of them is `ro`. A
 * symlink pointing outside the root still resolves outside the root; that target is
 * just as read-only as if the command had named it directly (verified: writing through
 * `ln -s /outside inside-root/escape; echo x > inside-root/escape/f` fails the same way
 * as a direct absolute-path write).
 *
 * `--user` maps the invoking (unprivileged) uid to root *inside the new namespace only*
 * — `man 7 user_namespaces` — which is what lets an ordinary process call `mount()` at
 * all; nothing about host-visible file ownership or privilege changes. This needs no
 * setup beyond `unshare`/`findmnt` (util-linux, present on every mori dev/CI image
 * already — `bash-exec.ts` already depends on `/bin/bash` existing on the same image).
 *
 * ## Why the mount list is walked instead of just remounting `/`
 *
 * A container's root is not always one mount. This dev/CI image alone has `/data` as a
 * separate `ext4` mount beside the overlay `/` — `mount -o remount,ro /` alone leaves
 * `/data` untouched and writable, recreating exactly the mori#489 hole (the leaked path
 * in that incident *was* `/data/repos/mori`). So every mount `findmnt` reports is
 * remounted read-only individually, except the ones under the working root.
 *
 * ## Why a remount failure aborts the command instead of continuing
 *
 * Swallowing a single failed remount (`|| true`) would make the boundary's strength
 * depend on which mounts happen to exist on a given host — exactly the "believed to
 * work and does not" failure mode `bash.ts`'s module comment warns about for command-
 * string guards. If even one mount cannot be locked down, the command never runs; the
 * model sees a tool error instead of a silent gap. The empty-`findmnt`/missing-`/`
 * checks below exist for the same reason: `findmnt` failing outright (missing binary,
 * unexpected output) must not be mistaken for "there was nothing to lock down".
 *
 * The working-root check (exit 92) is that same failure shape from the other side. The
 * loop skips mounts under the root by pattern (`"$ROOT"|"$ROOT"/*`), so a root of `/`
 * — or an empty one — matches every mount, and the loop runs to completion having
 * locked down nothing while reporting success. Callers do not pass such a root today
 * (`bash-exec.ts` hands over a realpath-resolved scratch dir), but the failure is silent
 * and total, which is the one kind worth a guard even when it is currently unreachable.
 *
 * ## What the confined command can still try, and why none of it reaches the host
 *
 * The boundary has to hold against a model that treats a blocked tool as a puzzle — that
 * is literally what mori#489 was. Each of these was run against this script and observed:
 *
 * - `mount -o remount,rw /tmp` — fails. Mounts inherited from the parent namespace are
 *   *locked* in a user namespace (`man 7 mount_namespaces`): restrictive flags can be
 *   added but never removed, so the command cannot undo its own confinement.
 * - `umount /tmp` (or `-l`) to expose whatever is underneath — fails, same locking rule.
 * - Nesting another `unshare --user --mount` to get a fresh, unlocked namespace — fails,
 *   and would not help if it did: the new namespace inherits the locked read-only mounts.
 * - `mount -t tmpfs none <outside-dir>` — succeeds, and is not an escape. The tmpfs lives
 *   in this command's own mount namespace, so nothing is written to the host filesystem
 *   and the mount disappears with the process.
 * - `node -e 'fs.writeFileSync("/data/repos/mori/…")'`, a `../` escape, a symlink planted
 *   inside the root, a `sh -c` subprocess — all fail with `EROFS`. None of them is a
 *   *path string a matcher missed*; they are `write()` calls the VFS refuses because the
 *   mount underneath the resolved path is `ro`, whichever process issued them.
 *
 * Writes to device nodes still work (`> /dev/null`, a terminal): `MS_RDONLY` governs the
 * filesystem, not the drivers behind character devices. That is deliberate — a boundary
 * that broke `2>/dev/null` would be worked around instead of respected.
 *
 * ## Why `set -ef`
 *
 * `-e` so a failed step aborts rather than running the command outside a half-built
 * boundary. `-f` because the mount list is word-split by the `for` loop, and a mount
 * point containing a glob character would otherwise be expanded against the filesystem
 * and remounted as the wrong path (or silently as none).
 *
 * ## Scope
 *
 * This is deliberately opt-in (`RunBashOptions.confineWrites`), not the new default for
 * every `bash` call. The interactive/dev-session `bash` tool stays exactly as
 * `bash.ts`'s module comment describes it — unsandboxed, because a developer session
 * already has, and needs, full host access. What changes here is the bench execution
 * path (`bench/preference-regression/runner.ts`'s `runPreferenceRegressionEpisode`),
 * which runs a model against prompts nobody has reviewed for what tool calls they might
 * provoke — precisely the case `bash.ts` already says "do not run this tool against
 * untrusted prompts" about.
 */

/**
 * Runs inside `unshare --user --map-root-user --mount -- /bin/bash -c "$BASH_JAIL_SCRIPT"
 * jail <root> <argv...>`. `$0` is conventionally "jail" (unused, just fills the slot so
 * `$1` is the working root); everything from `$2` on (`"$@"` after the `shift`) is the
 * real command to `exec` once the boundary is in place.
 *
 * Every early exit uses a distinct code (91-99) so a failure is diagnosable from the
 * `bash` tool's reported exit code alone, without needing the stderr text that came
 * with it.
 */
export const BASH_JAIL_SCRIPT = `set -ef
mount --make-rprivate / || { echo "mori bash jail: mount --make-rprivate failed" >&2; exit 97; }
ROOT=$1; shift
case "$ROOT" in
  ""|/) echo "mori bash jail: refusing an empty or filesystem-root working root ('$ROOT') — every mount would be skipped and nothing would be locked down" >&2; exit 92 ;;
  /*) ;;
  *) echo "mori bash jail: working root must be an absolute path, got '$ROOT'" >&2; exit 91 ;;
esac
command -v findmnt >/dev/null 2>&1 || { echo "mori bash jail: findmnt not found — cannot enumerate mounts to lock down" >&2; exit 96; }
MOUNTS=$(findmnt -rno TARGET) || { echo "mori bash jail: findmnt failed" >&2; exit 95; }
printf '%s\\n' "$MOUNTS" | grep -qx "/" || { echo "mori bash jail: root mount missing from findmnt output — refusing to proceed" >&2; exit 94; }
mount --bind "$ROOT" "$ROOT" || { echo "mori bash jail: failed to bind-mount the working root" >&2; exit 98; }
FAILED=0
IFS='
'
for target in $MOUNTS; do
  case "$target" in
    "$ROOT"|"$ROOT"/*) continue ;;
  esac
  mount -o remount,bind,ro "$target" || FAILED=1
done
unset IFS
if [ "$FAILED" -ne 0 ]; then
  echo "mori bash jail: one or more mounts could not be locked down — refusing to run the command" >&2
  exit 93
fi
cd "$ROOT" || { echo "mori bash jail: cd into the working root failed" >&2; exit 99; }
exec "$@"
`;

/**
 * `spawn(file, args, ...)` inputs that run `command` under the shell at `shellPath`,
 * confined to `root` by `BASH_JAIL_SCRIPT`. `root` must already be realpath-resolved
 * (`bash-exec.ts` does this before calling in) — the jail script bind-mounts it
 * verbatim, and a path containing a symlink component would bind the wrong thing.
 *
 * `command` is never interpolated into a script string — it travels as its own argv
 * element (`bash -c SCRIPT jail <root> <shellPath> -c <command>`, read back inside the
 * script via `"$@"` after `shift`), the same way the unconfined path already hands it to
 * `spawn`. The jail adds a mount-namespace boundary around that call; it does not change
 * how the command string itself is parsed or escaped.
 */
export function buildJailedSpawnArgs(
  shellPath: string,
  command: string,
  root: string,
): { file: string; args: string[] } {
  return {
    file: "unshare",
    args: [
      "--user",
      "--map-root-user",
      "--mount",
      "--",
      "/bin/bash",
      "-c",
      BASH_JAIL_SCRIPT,
      "jail",
      root,
      shellPath,
      "-c",
      command,
    ],
  };
}

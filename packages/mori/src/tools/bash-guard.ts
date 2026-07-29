/**
 * Destructive-command blocklist for the `bash` tool.
 *
 * This is a guard against accidents, not against an adversary — see the module comment
 * in `bash.ts` for what the tool as a whole does and does not protect against.
 */

/** One entry of the destructive-command blocklist. */
export interface BlockedCommandPattern {
  /** Stable id, used in the blocked reason and to pin one test per pattern. */
  id: string;
  /** Human-readable explanation handed back to the model. */
  description: string;
  /** Matched against the raw command string. */
  pattern: RegExp;
}

/**
 * Commands refused before execution.
 *
 * The list is data on purpose: it is the single place patterns are declared, and the
 * test suite asserts every id here has a case exercising it. Adding a pattern without
 * a test fails the suite.
 *
 * Scope is deliberately narrow — mistakes that are unrecoverable and have no plausible
 * legitimate form inside a working root. This blocklist is not a security boundary;
 * any of these effects can be reached by a command written differently.
 */
export const BASH_BLOCKED_PATTERNS: readonly BlockedCommandPattern[] = [
  {
    id: "rm-root",
    description: "deletes the filesystem root or the home directory",
    // `rm` with any flags, targeting `/`, `/*`, `~`, `~/*`, `$HOME` or `${HOME}`.
    pattern:
      /\brm\b(?:\s+-{1,2}\S+)*\s+(?:--\s+)?(?:\/|\/\*|~|~\/\*|\$HOME|\$\{HOME\})(?=\s|$|;|&|\|)/,
  },
  {
    id: "rm-no-preserve-root",
    description: "disables the filesystem-root safety check of rm",
    pattern: /--no-preserve-root\b/,
  },
  {
    id: "rm-system-directory",
    description: "deletes a system directory outside the working root",
    pattern:
      /\brm\b(?:\s+-{1,2}\S+)*\s+(?:--\s+)?\/(?:etc|usr|bin|sbin|boot|lib|lib64|var|sys|proc|dev|root|home)(?:\/\S*)?(?=\s|$|;|&|\|)/,
  },
  {
    id: "dd-to-disk-device",
    description: "writes a raw image over a disk device",
    pattern: /\bdd\b[^\n]*\bof=\/dev\/(?:[shv]d[a-z]|nvme\d|mmcblk\d|disk\d)/,
  },
  {
    id: "redirect-to-disk-device",
    description: "redirects output straight onto a disk device",
    pattern: />{1,2}\s*\/dev\/(?:[shv]d[a-z]|nvme\d|mmcblk\d|disk\d)/,
  },
  {
    id: "mkfs",
    description: "formats a filesystem, destroying everything on the target device",
    pattern: /\bmkfs(?:\.\w+)?\b/,
  },
  {
    id: "fork-bomb",
    description: "fork bomb — spawns processes until the machine stops responding",
    // `:(){ :|:& };:` and renamed variants; the backreference ties the three uses
    // of the same function name together.
    pattern:
      /(?:^|[\s;&|])([A-Za-z_.:][\w.:]*)\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&\s*;?\s*\}\s*;?\s*\1/,
  },
];

/** First blocklist entry matching `command`, or undefined. */
export function findBlockedPattern(command: string): BlockedCommandPattern | undefined {
  return BASH_BLOCKED_PATTERNS.find((entry) => entry.pattern.test(command));
}

/** Refusal message handed to the model. Says which rule fired so it can try another way. */
export function blockedReason(entry: BlockedCommandPattern): string {
  return `blocked by mori bash guard [${entry.id}]: ${entry.description}`;
}

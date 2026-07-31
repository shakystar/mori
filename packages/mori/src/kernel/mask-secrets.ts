/**
 * Masks credential-shaped values out of shell command text before it reaches
 * the memory kernel (#129).
 *
 * `observedShell` hands the raw command to `@mori/kernel`, whose event log is
 * append-only (packages/kernel/src/storage/event-store.ts) — nothing appended
 * can be edited or deleted later, only superseded going forward. A secret that
 * reaches that log survives in on-disk backups and is readable by any other
 * process on the same machine, so masking has to happen here, on mori's side
 * of the seam, before the command text is ever handed to the kernel.
 *
 * This is a seed list, not a secret scanner — it catches common credential
 * shapes and makes no claim to completeness. The goal is to catch the
 * frequent forms cheaply, not to guarantee no secret ever leaks; the true
 * safeguard is a human never needing to eyeball the raw event log at all.
 * Only the secret VALUE is replaced (`--token=***`); the rest of the command
 * is kept so the observation still says something useful.
 */

/** One entry of the secret-masking seed list. */
export interface SecretMaskPattern {
  /** Stable id, used to pin one test per pattern (mirrors bash-guard.ts). */
  id: string;
  description: string;
  /** Matched against the raw command. `$1`/`$2` in `replacement` refer to this. */
  pattern: RegExp;
  /** `String.replace` template — keeps everything except the secret value. */
  replacement: string;
}

/** Value characters allowed in a masked capture: no whitespace, no quotes (so a
 *  quoted value's closing quote survives the redaction instead of being eaten). */
const VALUE = `[^\\s"']+`;

export const SECRET_MASK_PATTERNS: readonly SecretMaskPattern[] = [
  {
    id: "url-userinfo",
    description: "user:password@ credentials embedded in a URL",
    pattern: /:\/\/[^\s/@]+:[^\s/@]+@/g,
    replacement: "://***@",
  },
  {
    id: "long-flag-value",
    description: "--token/--password/--secret/--api-key/--access-key style flag (= or space form)",
    pattern: new RegExp(
      `(--(?:token|password|passwd|secret|api-key|apikey|access-key|access-token|auth-token))([= ])${VALUE}`,
      "gi",
    ),
    replacement: "$1$2***",
  },
  {
    id: "short-p-flag",
    description:
      "-p<value> inline password flag (mysql/psql style, no separating space). " +
      "Known false-positive source: any other short flag shaped like -p<word> " +
      "(e.g. find's -print family does not collide, but a hypothetical -pFOO would) " +
      "— accepted because masking a non-secret value is cheap next to leaking one.",
    pattern: new RegExp(`(\\s-p)(?!\\s|$)${VALUE}`, "g"),
    replacement: "$1***",
  },
  {
    id: "bearer-token",
    description: "Authorization: Bearer <token> header",
    pattern: new RegExp(`(\\bBearer\\s+)${VALUE}`, "gi"),
    replacement: "$1***",
  },
  {
    id: "secret-env-assignment",
    description:
      "environment variable assignment whose name looks like a secret " +
      "(…SECRET…, …API_KEY…, …TOKEN…, …PASSWORD…)",
    pattern: new RegExp(
      `(\\b(?:[A-Z0-9]+_)*(?:SECRET|API_KEY|APIKEY|TOKEN|PASSWORD|PASSWD)(?:_[A-Z0-9]+)*=)${VALUE}`,
      "g",
    ),
    replacement: "$1***",
  },
];

/** Redacts every recognized secret shape in `command`, keeping the rest intact. */
export function maskSecrets(command: string): string {
  return SECRET_MASK_PATTERNS.reduce(
    (text, { pattern, replacement }) => text.replace(pattern, replacement),
    command,
  );
}

/**
 * Masks credential-shaped values out of shell command text before it reaches
 * the memory kernel (#129).
 *
 * `SECRET_MASK_PATTERNS` is the canonical definition of "category 1" (pattern-
 * matched credential shapes) in the storage-boundary forbidden list — see
 * `docs/storage-boundary-secrets.md` (#188 C). Do not duplicate this list
 * elsewhere; the kernel-side counterpart (category 2, write-tool payload
 * content) uses a different, pattern-free mechanism instead of importing this
 * one, because the kernel cannot depend on mori (see that doc for why).
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
 *
 * Value boundary rule (decided once here; every pattern that accepts a quoted
 * value follows it — see `VALUE_TOKEN`): a value either starts with a quote,
 * in which case it runs through the matching closing quote and whitespace
 * inside the quotes is NOT a terminator (`DB_PASSWORD='correct horse'` masks
 * to `DB_PASSWORD='***'`, not a truncated match) — or it has no opening quote,
 * in which case whitespace, a quote, and the shell control operators `;`/`|`/`&`
 * all terminate it. Quoting is the shell's own way of saying "this token may
 * contain the characters that would otherwise end it", so the rule inside
 * quotes has to be more permissive than outside them.
 *
 * Known gap (accepted, not fixed): command substitution (`` `cmd` ``, `$(cmd)`)
 * and here-docs aren't recognized as value forms, so a secret produced that way
 * (e.g. `--token=$(cat secret.txt)`) passes through unmasked. Catching those
 * would require actually parsing shell, not pattern-matching it.
 */

/** One entry of the secret-masking seed list. */
export interface SecretMaskPattern {
  /** Stable id, used to pin one test per pattern (mirrors bash-guard.ts). */
  id: string;
  description: string;
  /** Matched against the raw command. */
  pattern: RegExp;
  /** `String.replace` template, or a replacer function for patterns whose
   *  masked portion has to preserve quotes around a value that may itself
   *  contain whitespace — a static template can't branch on that. */
  replacement: string | ((...args: string[]) => string);
}

/** A credential value token: either a `"..."`/`'...'` quoted string — which may
 *  contain whitespace, since a real secret can (`DB_PASSWORD='correct horse'`) —
 *  or an unquoted run that stops at whitespace, a quote, or a shell control
 *  operator (`;`/`|`/`&`; without this exclusion the value would swallow the
 *  operator plus the start of the next command). Wrap in `()` at each use site
 *  so the replacer gets the whole token (quotes included) as one group. */
const VALUE_TOKEN = `(?:"[^"]*"|'[^']*'|[^\\s"';|&]+)`;

/** Unquoted-only value, for patterns that don't need quote support. */
const VALUE_UNQUOTED = `[^\\s"';|&]+`;

/** Replaces a captured value token with `***`, preserving its surrounding
 *  quotes (if any) so `'secret'` becomes `'***'` instead of losing the quotes
 *  or (worse) masking through them and eating the quote characters. */
function maskValueToken(token: string): string {
  const quote = token[0];
  if ((quote === '"' || quote === "'") && token.length >= 2 && token.at(-1) === quote) {
    return `${quote}***${quote}`;
  }
  return "***";
}

export const SECRET_MASK_PATTERNS: readonly SecretMaskPattern[] = [
  {
    id: "url-userinfo",
    description: "user:password@ credentials embedded in a URL",
    pattern: /:\/\/[^\s/@]+:[^\s/@]+@/g,
    replacement: "://***@",
  },
  {
    id: "long-flag-value",
    description:
      "--token/--password/--secret/--api-key/--access-key style flag (= form, or space form " +
      "separated by one or more spaces/tabs — but not a newline, so the next line's first " +
      "token in a multi-line command is never swallowed as the value)",
    pattern: new RegExp(
      `(--(?:token|password|passwd|secret|api-key|apikey|access-key|access-token|auth-token))(=|[ \\t]+)(${VALUE_TOKEN})`,
      "gi",
    ),
    replacement: (_match: string, flag: string, sep: string, value: string) =>
      `${flag}${sep}${maskValueToken(value)}`,
  },
  {
    id: "short-p-flag",
    description:
      "-p<value> inline password flag (mysql/psql style, no separating space). " +
      "Explicitly excludes find's -print/-print0/-printf/-perm/-path/-prune " +
      "primaries, which share the -p<word> shape but are not password flags.",
    pattern: new RegExp(
      `(\\s-p)(?!\\s|$)(?!(?:rint(?:0|f)?|erm|ath|rune)\\b)(${VALUE_TOKEN})`,
      "g",
    ),
    replacement: (_match: string, prefix: string, value: string) =>
      `${prefix}${maskValueToken(value)}`,
  },
  {
    id: "bearer-token",
    description:
      "Authorization: Bearer <token> header — requires an Authorization context so " +
      'prose that merely contains the word "Bearer" (e.g. a commit message) isn\'t masked',
    pattern: new RegExp(`(\\bAuthorization\\b\\s*:?\\s*Bearer\\s+)${VALUE_UNQUOTED}`, "gi"),
    replacement: "$1***",
  },
  {
    id: "secret-env-assignment",
    description:
      "environment variable assignment whose name *contains* a secret keyword " +
      "(…secret…, …api_key…, …token…, …password…) anywhere inside a valid shell " +
      "identifier — not just as an underscore-delimited segment, so `PGPASSWORD=`/ " +
      "`MYPASSWORD=` (no separating underscore) match same as `DB_PASSWORD=` does. " +
      "Matched case-insensitively since shell env var names are case-sensitive but " +
      "may legally be lowercase. Known false positive from case-insensitivity: " +
      "text-substitution commands whose argument merely contains one of these words " +
      "as a literal, e.g. `sed 's/password=old/password=new/'`, now match and get " +
      "partially redacted even though nothing there is a credential — accepted, " +
      "since over-redacting a non-secret is cheaper than leaking one. Widened further " +
      "by dropping the underscore requirement: identifiers where a keyword merely " +
      "appears as a substring flanked by other identifier characters, e.g. a " +
      "hypothetical `PASSWORDLESS=1`, now also match and get redacted — same " +
      "over-redact-over-leak tradeoff.",
    pattern: new RegExp(
      `(\\b[A-Z0-9_]*(?:SECRET|API_KEY|APIKEY|TOKEN|PASSWORD|PASSWD)[A-Z0-9_]*=)(${VALUE_TOKEN})`,
      "gi",
    ),
    replacement: (_match: string, prefix: string, value: string) =>
      `${prefix}${maskValueToken(value)}`,
  },
];

/** Redacts every recognized secret shape in `command`, keeping the rest intact. */
export function maskSecrets(command: string): string {
  return SECRET_MASK_PATTERNS.reduce((text, { pattern, replacement }) => {
    // Branched (not `text.replace(pattern, replacement)` directly): TS can't pick
    // the right `String.replace` overload from a union type without narrowing first.
    if (typeof replacement === "function") {
      return text.replace(pattern, replacement);
    }
    return text.replace(pattern, replacement);
  }, command);
}

/**
 * The one experimental, opt-in auth route mori has: OpenAI's ChatGPT subscription OAuth,
 * served by pi-ai's `openai-codex` provider.
 *
 * Human decision on #35 (2026-07-28), executed by #44: this route ships as an *unofficial*
 * development path — default off, reachable only through an environment variable, and never
 * promoted to a first-class feature until OpenAI's own auth documentation states that
 * third-party clients are allowed. The same decision rules Anthropic subscription OAuth out
 * entirely — not even behind a flag — so there is deliberately no equivalent gate for it.
 *
 * The gate is an env var rather than a CLI flag on purpose: a `--experimental-...` flag
 * shows up in `--help` and reads as "a supported feature", which is exactly what the
 * decision said this must not look like.
 */
export const EXPERIMENTAL_OPENAI_OAUTH_ENV = "MORI_EXPERIMENTAL_OPENAI_OAUTH";

/**
 * pi-ai's ChatGPT-subscription provider. Note this is *not* `openai`: they are separate
 * providers with disjoint auth (see #35 §4-2). `openai` talks to `api.openai.com/v1` and
 * authenticates with `OPENAI_API_KEY` only; `openai-codex` talks to
 * `chatgpt.com/backend-api` and authenticates with OAuth only — it has no API key at all,
 * which is why it has no entry in `PROVIDER_API_KEY_ENV`.
 */
export const OPENAI_OAUTH_PROVIDER_ID = "openai-codex";

/**
 * Off unless the gate is set to exactly `1`. Anything else — unset, empty, `0`, `true`,
 * `yes` — is off, because the cost of this gate being on by accident is an account
 * suspension, not a missing feature (#35 §6). The strict comparison is the point: it fails
 * closed on every value the human decision did not name.
 */
export function experimentalOpenAiOAuthEnabled(env: NodeJS.ProcessEnv): boolean {
  return env[EXPERIMENTAL_OPENAI_OAUTH_ENV]?.trim() === "1";
}

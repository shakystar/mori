# mori

Memory-native agent harness. Sessions die; memory remains.

## Quickstart

Run it once with `npx`, no install required:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npx @shakystar/mori "hi"
```

Or install it globally:

```bash
npm install -g @shakystar/mori
export ANTHROPIC_API_KEY=sk-ant-...
mori "hi"
```

### Authentication

mori resolves credentials in this order:

1. A credential stored by a prior `mori login` (at `$XDG_CONFIG_HOME/mori/credentials.json`,
   or `~/.config/mori/credentials.json`, written `0600`).
2. The provider's API key environment variable — `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.

If neither is available, `mori` exits immediately with an error naming both options — no
network round trip is attempted first.

```bash
mori login             # stores a key for the provider MORI_MODEL selects (anthropic by default)
mori login openai      # ...or for a provider you name
mori logout openai     # drops that provider's stored credential
```

For `anthropic` and `openai`, `mori login` prompts for an API key and stores it; it is a
convenience over exporting the environment variable, not a different kind of credential.
Neither provider has a subscription/OAuth login: Claude Pro/Max OAuth is deliberately not
implemented (it requires impersonating another client, which its terms forbid), and mori
strips that capability out of the provider it registers.

### Provider and model selection

mori supports two providers by default: `anthropic` (default) and `openai`. Both go through
their own API key (see Authentication above).

By default mori uses the anthropic model `claude-sonnet-4-6`. Override the model — and
optionally the provider — with `MORI_MODEL`:

```bash
# anthropic (default provider), just the model id, e.g.:
MORI_MODEL=claude-opus-5 mori "hi"

# a different provider: "<provider>/<model>"
export OPENAI_API_KEY=sk-...
MORI_MODEL=openai/gpt-5.4 mori "hi"
```

Rule: if `MORI_MODEL` contains a `/`, everything before it is the provider id and
everything after is the model id. A bare value (no `/`) has no provider and is read as an
anthropic model id, so the pre-existing `MORI_MODEL=claude-sonnet-4-6` form keeps working
unchanged. An unknown provider or model ends with an error listing what's supported —
no stack trace.

### Experimental: ChatGPT subscription login (unofficial, off by default)

> **This is not a supported feature, and using it may get your OpenAI account restricted or
> suspended.** OpenAI has never stated in its auth documentation that third-party clients
> may sign in with a ChatGPT subscription. This route exists as an unofficial development
> path only. If you need something that keeps working, use `OPENAI_API_KEY` with the
> `openai` provider above.

It is off unless you set the gate to exactly `1`, and while it is off the provider is not
registered at all — it does not appear in the supported-provider list, it cannot be selected
by `MORI_MODEL`, and `mori login` will not accept it as a target:

```bash
export MORI_EXPERIMENTAL_OPENAI_OAUTH=1
mori login openai-codex        # prints the risk notice on success
MORI_MODEL=openai-codex/gpt-5.1-codex mori "hi"
```

Note that `openai-codex` is a *different provider* from `openai`: it talks to
`chatgpt.com/backend-api` and has no API key path at all, so `OPENAI_API_KEY` does not
apply to it.

### Data location

mori's memory kernel keeps its on-disk state under `~/.mori` (override with
`MEMORIZE_ROOT`) — no per-account nesting, since mori has no CLI account
concept. Each project's `better-sqlite3` database lives at
`~/.mori/projects/<projectId>/mori.db`.

## Tools

### `bash` — not a sandbox

The `bash` tool runs shell commands in a child process. **It is not a sandbox, and it
does not confine the model to the working root.** A shell can read and write anything
the user running mori can; a command string is never parsed for intent, so
`cat ../../etc/passwd` leaves the working root and nothing stops it. String matching
cannot close that hole, and pretending otherwise would be worse than saying it plainly.

What the tool actually guarantees:

- the child's working directory is pinned to the working root, so relative paths have a
  known base
- a fixed list of obviously destructive commands (root deletion, `--no-preserve-root`,
  writes straight to a disk device, `mkfs`, fork bombs) is refused before execution by a
  `beforeToolCall` preflight hook — a guard against accidents, not against an adversary
- every command has a wall-clock timeout; on overrun the whole process group is killed
  and the partial output is returned with the timeout flagged
- output is capped per stream and truncation is reported
- stdin is not connected, so interactive commands fail immediately instead of hanging
- mori's own Anthropic credentials (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_ADMIN_KEY`) are removed from the child environment; everything else in the
  environment is inherited as-is

**Do not run mori with the `bash` tool enabled on untrusted prompts or untrusted
content.** Real isolation (container, seccomp, a permission system) is not implemented.

## Development

See [TESTING.md](./TESTING.md) for this repo's testing conventions before adding or
changing tests.

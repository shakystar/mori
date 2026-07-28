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

1. An OAuth token from a prior `mori login` (stored at
   `$XDG_CONFIG_HOME/mori/credentials.json`, or `~/.config/mori/credentials.json`).
2. The `ANTHROPIC_API_KEY` environment variable.

If neither is available, `mori` exits immediately with an error pointing at
`mori login` first and `ANTHROPIC_API_KEY` as the fallback — no network round trip
is attempted first.

`mori login` is not implemented yet — running it prints guidance to use
`ANTHROPIC_API_KEY` in the meantime. Until it exists, the only working path is the
environment variable above.

### Model override

By default mori uses `claude-sonnet-4-6`. Override it with `MORI_MODEL`:

```bash
MORI_MODEL=claude-opus-5 mori "hi"
```

### Data location

mori's memory kernel keeps its on-disk state under `~/.mori` (override with
`MEMORIZE_ROOT`) — no per-account nesting, since mori has no CLI account
concept. Each project's `better-sqlite3` database lives at
`~/.mori/projects/<projectId>/mori.db`.

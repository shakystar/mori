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

mori resolves credentials from the `ANTHROPIC_API_KEY` environment variable. If it
isn't set, `mori` exits immediately with an error explaining how to set it — no
network round trip is attempted first.

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

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

export type CliCommand =
  | { kind: "login"; providerId?: string }
  | { kind: "logout"; providerId?: string }
  /**
   * No prompt given. On a terminal this enters the REPL (#26); anywhere else there is no
   * one to prompt, so `runCli` falls back to printing usage (see index.ts).
   */
  | { kind: "repl" }
  | { kind: "prompt"; prompt: string };

export function parseCliCommand(argv: string[]): CliCommand {
  const [head, target] = argv;

  // `mori login`/`mori logout` take an optional provider id; without one they act on the
  // provider `MORI_MODEL` selects (see index.ts's `runCli`).
  if (head === "login" || head === "logout") {
    const providerId = target?.trim() || undefined;
    return { kind: head, ...(providerId ? { providerId } : {}) };
  }

  const prompt = argv.join(" ").trim();
  if (!prompt) {
    return { kind: "repl" };
  }

  return { kind: "prompt", prompt };
}

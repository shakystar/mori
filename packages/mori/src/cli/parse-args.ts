export type CliCommand =
  | { kind: "login"; providerId?: string }
  | { kind: "logout"; providerId?: string }
  | { kind: "no-prompt" }
  | { kind: "prompt"; prompt: string };

export function parseCliCommand(argv: string[]): CliCommand {
  const [head, target] = argv;

  // `mori login`/`mori logout` take an optional provider id; without one they act on the
  // provider `MORI_MODEL` selects (see index.ts's `runCli`).
  if (head === "login" || head === "logout") {
    return { kind: head, providerId: target?.trim() || undefined };
  }

  const prompt = argv.join(" ").trim();
  if (!prompt) {
    return { kind: "no-prompt" };
  }

  return { kind: "prompt", prompt };
}

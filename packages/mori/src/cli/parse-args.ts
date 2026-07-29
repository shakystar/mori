export type CliCommand =
  { kind: "login" } | { kind: "no-prompt" } | { kind: "prompt"; prompt: string };

export function parseCliCommand(argv: string[]): CliCommand {
  if (argv[0] === "login") {
    return { kind: "login" };
  }

  const prompt = argv.join(" ").trim();
  if (!prompt) {
    return { kind: "no-prompt" };
  }

  return { kind: "prompt", prompt };
}

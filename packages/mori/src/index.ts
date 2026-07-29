#!/usr/bin/env node
import { isMainEntry } from "./cli/entrypoint.js";
import {
  loginNotImplementedMessage,
  unauthenticatedMessage,
  usageMessage,
} from "./cli/messages.js";
import { parseCliCommand } from "./cli/parse-args.js";
import { runPrompt } from "./cli/runtime.js";
import type { RunCliDeps } from "./cli/types.js";
import {
  resolveProviderSelection,
  SUPPORTED_PROVIDER_IDS,
  unknownProviderMessage,
} from "./provider-selection.js";

export { unauthenticatedMessage, loginNotImplementedMessage };
export type { RunCliDeps };

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: RunCliDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = deps.stderr ?? ((chunk: string) => process.stderr.write(chunk));

  const { providerId } = resolveProviderSelection(env);
  if (!SUPPORTED_PROVIDER_IDS.includes(providerId)) {
    stderr(unknownProviderMessage(providerId));
    return 1;
  }

  const command = parseCliCommand(argv);
  if (command.kind === "login") {
    stderr(loginNotImplementedMessage(providerId));
    return 1;
  }
  if (command.kind === "no-prompt") {
    stderr(usageMessage);
    return 1;
  }

  return runPrompt(command.prompt, providerId, env, deps, { stdout, stderr });
}

const entry = process.argv[1];
if (isMainEntry(entry, import.meta.url)) {
  const exitCode = await runCli(process.argv.slice(2), process.env);
  process.exit(exitCode);
}

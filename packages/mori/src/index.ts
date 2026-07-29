#!/usr/bin/env node
import { isMainEntry } from "./cli/entrypoint.js";
import { runLogin, runLogout } from "./cli/login.js";
import { unauthenticatedMessage, usageMessage } from "./cli/messages.js";
import { parseCliCommand } from "./cli/parse-args.js";
import { runPrompt } from "./cli/runtime.js";
import type { RunCliDeps } from "./cli/types.js";
import {
  resolveProviderSelection,
  supportedProviderIds,
  unknownProviderMessage,
} from "./provider-selection.js";

export { unauthenticatedMessage };
export type { RunCliDeps };

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: RunCliDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = deps.stderr ?? ((chunk: string) => process.stderr.write(chunk));

  const command = parseCliCommand(argv);

  // login/logout may name their own target; everything else acts on whatever `MORI_MODEL`
  // selects. Either way the id is validated against the providers actually registered for
  // this environment (see `moriProviders`) before it reaches pi-ai, so a gated-off
  // experimental provider is rejected here exactly like a typo would be.
  const named =
    command.kind === "login" || command.kind === "logout" ? command.providerId : undefined;
  const providerId = named ?? resolveProviderSelection(env).providerId;
  if (!supportedProviderIds(env).includes(providerId)) {
    stderr(unknownProviderMessage(providerId, env));
    return 1;
  }

  if (command.kind === "login") {
    return runLogin(providerId, env, deps, { stdout, stderr });
  }
  if (command.kind === "logout") {
    return runLogout(providerId, env, deps, { stdout, stderr });
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

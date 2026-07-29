#!/usr/bin/env node
import { isMainEntry } from "./cli/entrypoint.js";
import { runLogin, runLogout } from "./cli/login.js";
import { unauthenticatedMessage, usageMessage } from "./cli/messages.js";
import { parseCliCommand } from "./cli/parse-args.js";
import { createTerminalInput, type ReplInputSource } from "./cli/repl-input.js";
import { runRepl } from "./cli/repl.js";
import { prepareAgent, runPrompt } from "./cli/runtime.js";
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
  if (command.kind === "repl") {
    const input = (deps.openReplInput ?? defaultReplInput)();
    // No terminal means no one to prompt. Printing usage and failing keeps the pre-REPL
    // behaviour of `mori` with no arguments for scripts and pipes, and is the documented
    // answer to "what happens when stdin is not a TTY" (#26) — notably, it cannot spin.
    if (!input) {
      stderr(usageMessage);
      return 1;
    }

    // Opening the terminal puts it in raw mode, so from here on Ctrl-C arrives as a
    // keystroke rather than as a process signal — and `runRepl`'s handler for it does not
    // exist yet. Covering the preparation window is what keeps a slow credential lookup or
    // token refresh from being uninterruptible: leaving is a normal exit, code 0.
    //
    // Everything from here on runs under a `finally` that closes `input` — restoring raw
    // mode — no matter which of the paths below is taken, including `preparing` rejecting
    // (#80). `input.close()` is idempotent (readline's own `close()` is a no-op past the
    // first call, and so is re-removing a listener or re-applying the same raw-mode flag),
    // so `runRepl`'s own `finally` closing it again on the success path is harmless.
    try {
      let stopStartupListening = (): void => {};
      const startupInterrupt = new Promise<"interrupted">((resolve) => {
        stopStartupListening = input.onInterrupt(() => resolve("interrupted"));
      });

      const preparing = prepareAgent(providerId, env, deps, { stdout, stderr });
      let prepared: Awaited<typeof preparing> | "interrupted";
      try {
        prepared = await Promise.race([preparing, startupInterrupt]);
      } finally {
        stopStartupListening();
      }

      if (prepared === "interrupted") {
        // Nothing is awaiting the preparation any more; a later failure from it is not an
        // unhandled rejection, it is a result nobody asked for.
        void preparing.catch(() => {});
        stdout("\n");
        return 0;
      }

      if (!prepared.ok) {
        return prepared.exitCode;
      }

      return await runRepl(prepared.agent, input, { stdout, stderr });
    } finally {
      input.close();
    }
  }

  return runPrompt(command.prompt, providerId, env, deps, { stdout, stderr });
}

/** A readline REPL over the process's own stdin, but only when that stdin is a terminal. */
function defaultReplInput(): ReplInputSource | undefined {
  if (!process.stdin.isTTY) return undefined;
  return createTerminalInput(process.stdin, process.stdout);
}

const entry = process.argv[1];
if (isMainEntry(entry, import.meta.url)) {
  const exitCode = await runCli(process.argv.slice(2), process.env);
  process.exit(exitCode);
}

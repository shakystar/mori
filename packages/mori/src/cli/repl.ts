import type { Agent } from "@earendil-works/pi-agent-core";
import type { ConsolidatorLlm } from "@mori/kernel";
import type { MoriKernel } from "../agent/index.js";
import { consolidateExplicit } from "./consolidation.js";
import {
  replBanner,
  replClearedMessage,
  replConsolidateCancelledMessage,
  replConsolidateFailedMessage,
  replConsolidateOkMessage,
  replConsolidateSkippedMessage,
  replTurnCancelledMessage,
} from "./messages.js";
import type { ReplInputSource } from "./repl-input.js";

export interface ReplIO {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

/**
 * The kernel + consolidator LLM `/consolidate` needs — the same pair `runCli`'s session-end
 * trigger already holds (index.ts), just handed down one level for the explicit path (#107).
 */
export interface ReplConsolidation {
  kernel: MoriKernel;
  llm: ConsolidatorLlm | undefined;
}

/** The meta commands the REPL understands (#26 fixed `/exit`/`/clear`, #107 added `/consolidate`). */
const EXIT_COMMAND = "/exit";
const CLEAR_COMMAND = "/clear";
const CONSOLIDATE_COMMAND = "/consolidate";

const PROMPT = "› ";

/**
 * The REPL loop: read a line, run it as a turn on `agent`, repeat.
 *
 * `agent` is taken as a parameter rather than built here, and that is the whole design.
 * A turn's context is `agent.state.messages`, and the kernel wiring hangs off the instance
 * (`transformContext`, see agent.ts), so rebuilding the agent per turn would silently drop
 * both. Because this function has no way to construct one, multi-turn continuity holds by
 * construction instead of by discipline.
 *
 * Returns the process exit code. Unlike `runPrompt`, a failed turn does not end the
 * session — the error is reported and the loop asks for the next line — so this returns 0
 * for every way a user can leave the REPL (EOF, `/exit`, Ctrl-C while idle).
 */
export async function runRepl(
  agent: Agent,
  input: ReplInputSource,
  io: ReplIO,
  consolidation: ReplConsolidation,
): Promise<number> {
  const { stdout, stderr } = io;

  // Ctrl-C during a turn cancels that turn only. pi-agent-core threads the run's
  // AbortSignal down to the provider stream and the tool calls, and reports the outcome as
  // an assistant message with stopReason "aborted" rather than by throwing — so the loop
  // below simply continues to the next prompt.
  const stopListening = input.onInterrupt(() => agent.abort());

  stdout(replBanner());

  try {
    for (;;) {
      const line = await input.readLine(PROMPT);

      // Ctrl-C with nothing running is a request to leave, same as Ctrl-D. The newline
      // keeps the shell prompt off the half-written input line.
      if (line.type === "eof" || line.type === "interrupt") {
        stdout("\n");
        return 0;
      }

      const text = line.value.trim();

      // An empty line must not reach the provider: it would cost a request and, on some
      // providers, be rejected outright.
      if (!text) continue;

      if (text === EXIT_COMMAND) return 0;

      if (text === CLEAR_COMMAND) {
        agent.reset();
        stdout(replClearedMessage());
        continue;
      }

      if (text === CONSOLIDATE_COMMAND) {
        // A boundary can run for minutes (it includes an extraction LLM call), so it needs
        // its own cancellation path rather than relying on `agent.abort()` above, which only
        // ever affects a running turn. This handler is added ON TOP of `stopListening` for
        // the duration of the call and removed once it settles — Ctrl-C during `/consolidate`
        // then fires both (agent.abort() is a harmless no-op with no turn running).
        const controller = new AbortController();
        const stopConsolidateInterrupt = input.onInterrupt(() => controller.abort());
        try {
          const outcome = await consolidateExplicit(
            consolidation.kernel,
            consolidation.llm,
            controller.signal,
          );
          if (outcome.kind === "skipped") stdout(replConsolidateSkippedMessage());
          else if (outcome.kind === "ok") stdout(replConsolidateOkMessage());
          else if (outcome.kind === "cancelled") stderr(replConsolidateCancelledMessage());
          else stderr(replConsolidateFailedMessage(outcome.error));
        } finally {
          stopConsolidateInterrupt();
        }
        continue;
      }

      await agent.prompt(text);
      stdout("\n");

      const last = agent.state.messages.at(-1);
      if (last?.role !== "assistant") continue;

      if (last.stopReason === "aborted") {
        stderr(replTurnCancelledMessage());
      } else if (last.stopReason === "error") {
        stderr(`mori: ${last.errorMessage ?? "unknown provider error"}\n`);
      }
    }
  } finally {
    stopListening();
    input.close();
  }
}

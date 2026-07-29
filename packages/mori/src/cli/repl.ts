import type { Agent } from "@earendil-works/pi-agent-core";
import { replBanner, replClearedMessage, replTurnCancelledMessage } from "./messages.js";
import type { ReplInputSource } from "./repl-input.js";

export interface ReplIO {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

/** The only two meta commands the REPL understands (#26 fixes the set at these two). */
const EXIT_COMMAND = "/exit";
const CLEAR_COMMAND = "/clear";

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
export async function runRepl(agent: Agent, input: ReplInputSource, io: ReplIO): Promise<number> {
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

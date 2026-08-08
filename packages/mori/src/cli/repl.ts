import type { ConsolidatorLlm } from "@mori/kernel";
import type { MoriAgent, MoriKernel } from "../agent/index.js";
import { compactIfContextFull } from "./compaction.js";
import { consolidateExplicit, type ExplicitConsolidateOutcome } from "./consolidation.js";
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
 * A turn's context is the harness's own session, and the kernel wiring hangs off the
 * instance (`transformContext`, see agent/index.ts), so rebuilding the agent per turn would
 * silently drop both. Because this function has no way to construct one, multi-turn
 * continuity holds by construction instead of by discipline.
 *
 * Returns the process exit code. Unlike `runPrompt`, a failed turn does not end the
 * session — the error is reported and the loop asks for the next line — so this returns 0
 * for every way a user can leave the REPL (EOF, `/exit`, Ctrl-C while idle).
 */
export async function runRepl(
  agent: MoriAgent,
  input: ReplInputSource,
  io: ReplIO,
  consolidation: ReplConsolidation,
): Promise<number> {
  const { stdout, stderr } = io;

  // Ctrl-C during a turn cancels that turn only. pi-agent-core threads the run's
  // AbortSignal down to the provider stream and the tool calls, and reports the outcome as
  // an assistant message with stopReason "aborted" rather than by throwing — so the loop
  // below simply continues to the next prompt.
  //
  // `onInterrupt` takes a void-returning handler, but the harness's `abort()` returns
  // `Promise<AbortResult>` — fire-and-forget here needs an explicit rejection sink or a
  // failing abort takes the process down as an unhandled rejection. Swallowed rather than
  // reported: the only way it rejects is a subscriber throwing on the harness's own `abort`
  // event, and mori registers no such subscriber.
  const stopListening = input.onInterrupt(() => {
    void agent.abort().catch(() => {});
  });

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
        await agent.resetSession();
        // The kernel's own conversation-scoped state (#234) — the untargeted
        // session-start read it has already spent, the last turn it retrieved
        // for — must reset alongside the session, or the next conversation
        // inherits the previous one's "already asked" bookkeeping and silently
        // loses its session-start injection.
        consolidation.kernel.resetConversation();
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
          let outcome: ExplicitConsolidateOutcome;
          try {
            // `observe()` only enqueues (agent/index.ts) — without settling that queue
            // first, the boundary below can read the store before the turn just typed
            // has landed in it, miss that turn, and still report `{ kind: "ok" }`. The
            // session-end trigger already drains before its boundary (runtime.ts); this
            // makes the manual one do the same (#355).
            await consolidation.kernel.drain();
            outcome = await consolidateExplicit(
              consolidation.kernel,
              consolidation.llm,
              controller.signal,
            );
          } catch (error) {
            // `drain()` failing here is treated the same as the boundary itself
            // failing — this handler's rule is that a failed `/consolidate` reports
            // and keeps prompting rather than ending the session, and `drain()` is
            // just an earlier stage of the same attempt (#355).
            outcome = { kind: "failed", error };
          }
          if (outcome.kind === "skipped") stdout(replConsolidateSkippedMessage());
          else if (outcome.kind === "ok") stdout(replConsolidateOkMessage());
          else if (outcome.kind === "cancelled") stderr(replConsolidateCancelledMessage());
          else stderr(replConsolidateFailedMessage(outcome.error));
        } finally {
          stopConsolidateInterrupt();
        }
        continue;
      }

      const last = await agent.prompt(text);
      stdout("\n");

      if (last.stopReason === "aborted") {
        stderr(replTurnCancelledMessage());
      } else if (last.stopReason === "error") {
        stderr(`mori: ${last.errorMessage ?? "unknown provider error"}\n`);
      } else {
        // Between-turns compaction (#409). Here rather than inside the turn because
        // `compact()` needs an idle harness, and never throws (compaction.ts reports through
        // `stderr`), so a failed compaction cannot end a REPL session.
        //
        // Only after a turn that ran to completion. A cancelled turn is the user asking for
        // the prompt back, and `compact()` builds its summary on an `AbortSignal` of its own
        // that no Ctrl-C reaches — starting one there would hand back an unresponsive
        // session instead. A failed turn contributed nothing to the context worth
        // summarizing, and its most likely cause (the provider) is what a compaction would
        // have to reach anyway. Both re-measure at the end of the next turn.
        await compactIfContextFull(agent, stderr);
      }
    }
  } finally {
    stopListening();
    input.close();
  }
}

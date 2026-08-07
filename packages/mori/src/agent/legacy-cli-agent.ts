/**
 * TEMPORARY — DELETED BY #382.
 *
 * The three `Agent` members `cli/repl.ts` and `cli/runtime.ts` still call, kept working on
 * top of an `AgentHarness`. #381 moved `createMoriAgent` onto the harness and stopped
 * there; #382 replaces those three call sites (`state.messages` -> `prompt()`'s return
 * value, `reset()` -> `Session.moveTo(null)`, `abort()` -> the harness's own `abort()`) and
 * removes this file. Deleting it is that issue's completion condition, so nothing here may
 * grow: the exported surface is exactly the three members the CLI calls today, and every
 * convenience method someone is tempted to add is one more call site #382 has to unwind.
 *
 * Deliberately untested on its own (#381 says so in as many words): a test written against
 * this layer is thrown away with it, and the layer's only job is to keep the existing CLI
 * tests green — which is the check that it works.
 */
import type { AgentHarness, AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * `AgentHarness` wearing the `Agent` members the CLI has not moved off yet.
 *
 * `abort` is subtracted from the harness rather than added on top of it: the harness's own
 * `abort()` returns `Promise<AbortResult>`, and `cli/repl.ts` hands `() => agent.abort()` to
 * an interrupt handler declared `() => void` — a promise-returning function there is both a
 * lint error (`@typescript-eslint/no-misused-promises`) and an unhandled rejection waiting
 * to happen. So the adapter shadows it with the void-returning shape that call site was
 * written against. #382 takes the promise (and the rejection sink it needs) instead.
 */
export type MoriAgent = Omit<AgentHarness, "abort"> & {
  /** `agent.state.messages` — the running transcript, as the low-level `Agent` exposed it. */
  readonly state: { readonly messages: AgentMessage[] };
  /** `agent.reset()` — `/clear`'s "the next turn does not see the past". */
  reset(): void;
  /** `agent.abort()` — fire-and-forget cancellation of the running turn, as `Agent` had it. */
  abort(): void;
};

export interface LegacyCliAgent {
  /** The harness, with the three legacy members attached. */
  agent: MoriAgent;
  /**
   * The tail of a context that `/clear` has not retired, given the full context the harness
   * built for this request.
   *
   * `reset()` cannot empty the session here — replacing the conversation is `Session.moveTo(null)`
   * and that is #382's, by human decision (#7). What it can do is remember how much of the
   * session predates the last `/clear` and drop exactly that prefix on the way to the model,
   * which is the behavior `Agent.reset()` had. Call this on the `context` hook's messages
   * before the kernel sees them, so retrieval reasons about the same conversation the model
   * will: the prefix is gone for both, or for neither.
   *
   * Counting works because the two sequences are the same sequence: the harness appends one
   * session entry per `message_end`, in order, and that is the event this layer counts. So
   * "the first N messages of the context" and "the first N messages this layer saw" name the
   * same messages.
   */
  sinceLastReset(messages: AgentMessage[]): AgentMessage[];
}

/**
 * Attaches the legacy members to `harness` and returns it.
 *
 * Mutates rather than wraps, on purpose: a wrapper would have to re-expose every harness
 * method by hand (and get `this` right on each), and a `Object.create`-style delegate would
 * split the harness's own state across two objects. The harness is constructed one line
 * earlier by `createMoriAgent` and never escapes untouched, so the mutation has no other
 * observer.
 */
export function attachLegacyCliAgent(harness: AgentHarness): LegacyCliAgent {
  const messages: AgentMessage[] = [];
  /** Every message this layer has ever seen — `reset()` does not rewind it, so it keeps naming session positions. */
  let seen = 0;
  /** How many leading session messages the last `reset()` retired. */
  let retired = 0;

  const abortRun = harness.abort.bind(harness);

  harness.subscribe((event) => {
    if (event.type !== "message_end") return;
    messages.push(event.message);
    seen += 1;
  });

  const agent = Object.assign(harness, {
    // A fixed object over a fixed array: `reset()` empties the array in place, so a caller
    // that held on to `agent.state` (or to `agent.state.messages`) keeps seeing the truth.
    state: { messages },
    reset(): void {
      retired = seen;
      messages.length = 0;
    },
    abort(): void {
      // `Agent.abort()` returned void and could not report a failure; keeping that shape
      // means swallowing this promise's rejection rather than leaving it unhandled (which
      // takes the process down). The only way it rejects is a subscriber throwing on the
      // harness's own `abort` event, and mori registers no such subscriber.
      void abortRun().catch(() => {});
    },
  }) as unknown as MoriAgent;

  return {
    agent,
    sinceLastReset: (contextMessages) => contextMessages.slice(retired),
  };
}

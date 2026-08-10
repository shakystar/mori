import type { MessageEntry } from "@earendil-works/pi-agent-core";
import { contentText, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import {
  resolveProviderSelection,
  supportedProviderIds,
  unknownProviderMessage,
} from "./agent/provider-selection.js";
import { compactIfContextFull } from "./cli/compaction.js";
import {
  consolidateExplicit,
  consolidateOnSessionEnd,
  type ExplicitConsolidateOutcome,
} from "./cli/consolidation.js";
import { prepareAgent, sessionEndLlm } from "./cli/runtime.js";
import type { RunCliDeps } from "./cli/types.js";

export type { ExplicitConsolidateOutcome };

/** What a single `MoriSession.prompt()` call produced. */
export interface MoriSessionTurn {
  /** The turn's final assistant reply, its text content joined (`contentText`). */
  text: string;
  /** `stopReason` off the turn's final assistant reply — `"error"`/`"aborted"` on failure. */
  stopReason: AssistantMessage["stopReason"];
  /**
   * Usage summed across every provider round-trip this turn made — a tool-call loop turns
   * one `prompt()` into several separately-billed requests, and a caller costing a turn
   * needs all of them, not just the last.
   */
  usage: Usage;
}

/** What a single `MoriSession.compact()` call produced. */
export interface MoriSessionCompaction {
  /** The summary the harness's own compaction left in place of the conversation it cut. */
  summary: string;
  /** Usage of the LLM call that produced the summary — zero if the provider reported none. */
  usage: Usage;
}

/**
 * A programmatic, TTY-free multi-turn mori session (#341, #340 조각 1/5) — the shape a
 * benchmark harness drives an episode through: create once, `prompt()` per turn,
 * `consolidate()` at a chosen boundary, `close()` at episode end.
 *
 * This is not a new engine. `runPrompt` (one-shot) and `runRepl` (interactive, cli/repl.ts)
 * already sit on top of exactly this sequence — `prepareAgent` -> `agent.prompt` ->
 * `consolidateExplicit`/`consolidateOnSessionEnd` -> `kernel.drain` (cli/runtime.ts) — so this
 * module is that same internal shape, exposed without a terminal or a CLI argv in the way.
 */
export interface MoriSession {
  /**
   * Runs one turn to completion and reports its outcome. Never throws for a provider-side
   * failure — that surfaces as `stopReason: "error"` or `"aborted"`, the same contract
   * `agent.prompt` itself follows (see cli/repl.ts's equivalent check after every turn).
   *
   * Queues behind whatever `prompt()`/`consolidate()`/`close()` call on this session is already
   * in flight (#371) — this call's kernel work only starts once that one has settled, so it
   * cannot land observations out of order with it.
   */
  prompt(text: string): Promise<MoriSessionTurn>;
  /**
   * Runs a manual consolidation boundary now — the SDK equivalent of the REPL's `/consolidate`
   * (cli/repl.ts). Throws once `close()` has been called, same table as `prompt()`.
   *
   * Queues behind whatever call is already in flight, same ordering guarantee as `prompt()`
   * above (#371).
   */
  consolidate(signal?: AbortSignal): Promise<ExplicitConsolidateOutcome>;
  /**
   * Runs the harness's own compaction now and hands back the summary it produced — the same
   * `AgentHarness.compact()` that `compactIfContextFull` (cli/compaction.ts) fires once the
   * context window fills, triggered by the caller instead of by the threshold. The compaction
   * path itself stays entirely pi's: mori declares no summary prompt and no second threshold
   * of its own (정본 문서 §6.1), and this method adds neither.
   *
   * Its one caller is the preference-regression OFF arm (bench/preference-regression/runner.ts,
   * #434). "What would have survived the session's death if mori were not here?" has exactly
   * one honest answer — the harness's default compaction summary — and handing that answer to
   * the follow-up session requires getting it out of the session it was made in.
   *
   * Queues behind whatever `prompt()`/`consolidate()`/`close()` call is in flight, same
   * ordering as `prompt()`: `compact()` requires an idle harness (cli/compaction.ts) and
   * rejects with `busy` if it lands mid-turn.
   *
   * Rejects rather than reporting through `stderr`, unlike the between-turns trigger. That
   * trigger's failure is benign (the context is merely still too big and the next turn
   * re-measures), but this caller asked for the summary itself — quietly answering with an
   * empty one would let the OFF arm report "it saw a compaction summary" when it saw nothing.
   */
  compact(): Promise<MoriSessionCompaction>;
  /**
   * Settles queued observations and runs the session-end consolidation trigger. Call once, at
   * episode end, in place of the process exit that does this for the CLI (cli/runtime.ts's
   * `runPrompt`, index.ts's REPL exit path) — that "once, at the end" phrasing is a usage
   * convention this type does not enforce: nothing rejects an early or overlapping call, because
   * every ordering is made safe instead (see below).
   *
   * Idempotent under concurrency, not just in sequence: every call — first or Nth, awaited
   * back-to-back or fired off in parallel — shares the same underlying settle and returns once
   * `drain()` and the session-end boundary have actually finished, never before. If that settle
   * throws, every caller (past and future) sees the same rejection; a cleanup failure never
   * quietly reads as "closed".
   *
   * That settle itself never starts ahead of a `prompt()`/`consolidate()` call already in flight
   * on this session (#371): every kernel-touching call queues on one shared order, so a `close()`
   * that arrives mid-turn (the caller never awaited `prompt()` before calling it — an episode
   * timeout/abort path, not a bug) waits behind that turn instead of draining around it. A turn's
   * late-arriving observation is never silently unsettled at episode end.
   */
  close(): Promise<void>;
}

export type CreateMoriSessionResult =
  { ok: true; session: MoriSession } | { ok: false; exitCode: number };

/**
 * Builds a `MoriSession`: credential/auth gate -> kernel/agent construction, exactly what
 * `prepareAgent` (cli/runtime.ts) already does for `runCli` — this function IS that
 * preparation, returning a session façade instead of the raw agent/kernel/llm tuple `runCli`
 * unpacks by hand. `{ ok: false, exitCode }` on an unsupported provider or failed auth check
 * mirrors `PreparedAgent`'s own contract; the caller-facing message has already gone to
 * `deps.stderr`.
 *
 * `deps` is the same `RunCliDeps` the CLI uses (`credentialStore`/`streamFn`/`kernel`/`root`),
 * so a test — or a benchmark harness — can inject a fake model stream and an in-memory kernel
 * exactly like `runCli`'s own test suite does (index.test.ts), with no real provider or
 * on-disk store required to drive a multi-turn session.
 */
export async function createMoriSession(
  env: NodeJS.ProcessEnv = process.env,
  deps: RunCliDeps = {},
): Promise<CreateMoriSessionResult> {
  const stdout = deps.stdout ?? (() => {});
  const stderr = deps.stderr ?? (() => {});

  const providerId = resolveProviderSelection(env).providerId;
  if (!supportedProviderIds(env).includes(providerId)) {
    stderr(unknownProviderMessage(providerId, env));
    return { ok: false, exitCode: 1 };
  }

  const prepared = await prepareAgent(providerId, env, deps, { stdout, stderr });
  if (!prepared.ok) return prepared;

  const { agent, kernel, llm, projectId } = prepared;
  // In-flight/settled close(), not a boolean: a second call — concurrent or later — must
  // observe the *same* settle as the first, not a premature "done" while drain()/session-end
  // are still running (owner review, PR #350).
  let closePromise: Promise<void> | undefined;

  function assertOpen(method: string): void {
    if (closePromise) {
      throw new Error(`mori: session is closed — ${method}() cannot be called after close()`);
    }
  }

  // Every kernel-touching call — `prompt()`, `consolidate()`, `close()` — runs its work chained
  // onto this single tail instead of firing it off the moment it's called (#371). That is what
  // stops `close()`'s drain from starting ahead of a `prompt()`/`consolidate()` the caller never
  // awaited: whichever of those enqueued first still has `tail` pointing at its own settle when
  // `close()` enqueues, so `close()`'s work can only start after it. `enqueue` is synchronous up
  // to its `tail` reassignment (no `await` before it runs), so two calls made back-to-back with
  // no intervening `await` — e.g. `prompt()` then immediately `close()` — can never both read the
  // same stale `tail` and race each other in.
  let tail: Promise<void> = Promise.resolve();

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = tail.then(work, work);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    ok: true,
    session: {
      async prompt(text: string): Promise<MoriSessionTurn> {
        assertOpen("prompt");

        return enqueue(async () => {
          // A tool-call loop turns one `prompt()` into several provider round-trips, each
          // its own assistant reply — `prompt()`'s return value is only the last of those,
          // so summing usage across the whole turn reads the session's own append-only
          // entry log instead (agent/index.ts's `getEntries`, #398), sliced to what this
          // call added.
          const before = (await agent.getEntries()).length;
          await agent.prompt(text);
          const replies = (await agent.getEntries())
            .slice(before)
            .filter((entry): entry is MessageEntry => entry.type === "message")
            .map((entry) => entry.message)
            .filter((message): message is AssistantMessage => message.role === "assistant");
          const last = replies.at(-1);

          // Between-turns compaction (#409), the same trigger the REPL runs after a turn
          // (cli/repl.ts) — an episode long enough to overflow the context window has to
          // survive it here too, or a benchmark run would simply fail at the provider once
          // the window fills. Inside `enqueue`, so it settles before the next `prompt()` or
          // `close()` starts and `compact()` sees the idle harness it requires. Skipped on
          // a cancelled or failed turn for the reasons repl.ts records.
          if (last && last.stopReason !== "aborted" && last.stopReason !== "error") {
            await compactIfContextFull(agent, stderr);
          }

          return {
            text: last ? contentText(last.content) : "",
            stopReason: last?.stopReason ?? "error",
            usage: sumUsage(replies.map((reply) => reply.usage)),
          };
        });
      },

      async consolidate(signal?: AbortSignal): Promise<ExplicitConsolidateOutcome> {
        // `async` (not a bare passthrough) so `assertOpen`'s throw rejects the returned
        // promise instead of escaping synchronously — the same failure shape `prompt()` gives.
        assertOpen("consolidate");

        return enqueue(async () => {
          // `observe` is fire-and-forget (agent/index.ts), so the turn that just finished may
          // still have an unpersisted observation queued when this boundary starts. Drain first,
          // same ordering as runPrompt's finally (cli/runtime.ts), so the boundary's window
          // includes everything up to this call rather than missing it until the next one
          // (Codex review, PR #350).
          await kernel.drain();
          return consolidateExplicit(kernel, llm, signal);
        });
      },

      async compact(): Promise<MoriSessionCompaction> {
        // `async` for the same reason `consolidate()` is: `assertOpen`'s throw has to reject
        // the returned promise, not escape synchronously.
        assertOpen("compact");

        return enqueue(async () => {
          const result = await agent.compact();
          // `usage` is optional on `CompactResult` — a provider that reports none must read as
          // "this cost nothing we can see", not as a missing field the caller has to handle.
          return { summary: result.summary, usage: result.usage ?? ZERO_USAGE };
        });
      },

      close(): Promise<void> {
        // Assigning the promise synchronously — before any `await` runs — is what makes this
        // safe under concurrency: a second `close()` that arrives before the first has settled
        // still sees `closePromise` already set (there is no gap where two calls could each
        // start their own drain()) and returns that exact promise. A rejection stays cached
        // as-is rather than being retried or swallowed — surfacing the same cleanup failure to
        // every caller is what stops "closed" from lying about the state of the world.
        //
        // `enqueue` (not a bare async IIFE) is what makes this wait for an in-flight
        // `prompt()`/`consolidate()` instead of draining around it (#371) — see `enqueue`'s own
        // comment above for why this can't race an unawaited call to either.
        closePromise ??= enqueue(async () => {
          // Same ordering as runPrompt's finally (cli/runtime.ts): drain queued observations
          // before the session-end trigger, so the boundary sees everything this episode did.
          await kernel.drain();
          await consolidateOnSessionEnd(kernel, sessionEndLlm(llm, projectId), stderr);
        });
        return closePromise;
      },
    },
  };
}

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * `cacheWrite1h`/`reasoning` stay absent from the sum unless at least one summed call
 * reported one — matching `Usage`'s own "left undefined by providers that don't" contract
 * rather than coercing an unsupported provider's turn to a misleading `0`.
 *
 * Exported for bench/cost-ledger.ts (#373), which reduces the same `Usage[]` shape into a
 * run's per-axis totals and needs the exact same optional-field handling this turn-summing
 * already has — duplicating it would risk the two silently drifting apart.
 */
export function sumUsage(usages: Usage[]): Usage {
  return usages.reduce(
    (total, usage) => ({
      input: total.input + usage.input,
      output: total.output + usage.output,
      cacheRead: total.cacheRead + usage.cacheRead,
      cacheWrite: total.cacheWrite + usage.cacheWrite,
      ...addOptional(total.cacheWrite1h, usage.cacheWrite1h, "cacheWrite1h"),
      ...addOptional(total.reasoning, usage.reasoning, "reasoning"),
      totalTokens: total.totalTokens + usage.totalTokens,
      cost: {
        input: total.cost.input + usage.cost.input,
        output: total.cost.output + usage.cost.output,
        cacheRead: total.cost.cacheRead + usage.cost.cacheRead,
        cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
        total: total.cost.total + usage.cost.total,
      },
    }),
    ZERO_USAGE,
  );
}

function addOptional<K extends string>(
  a: number | undefined,
  b: number | undefined,
  key: K,
): Record<K, number> | Record<string, never> {
  if (a === undefined && b === undefined) return {};
  return { [key]: (a ?? 0) + (b ?? 0) } as Record<K, number>;
}

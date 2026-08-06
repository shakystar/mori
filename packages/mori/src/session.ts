import { contentText, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import {
  resolveProviderSelection,
  supportedProviderIds,
  unknownProviderMessage,
} from "./agent/provider-selection.js";
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
   */
  prompt(text: string): Promise<MoriSessionTurn>;
  /** Runs a manual consolidation boundary now — the SDK equivalent of the REPL's `/consolidate` (cli/repl.ts). */
  consolidate(signal?: AbortSignal): Promise<ExplicitConsolidateOutcome>;
  /**
   * Settles queued observations and runs the session-end consolidation trigger. Call once, at
   * episode end, in place of the process exit that does this for the CLI (cli/runtime.ts's
   * `runPrompt`, index.ts's REPL exit path). Idempotent — a later call is a no-op.
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
  let closed = false;

  return {
    ok: true,
    session: {
      async prompt(text: string): Promise<MoriSessionTurn> {
        if (closed) {
          throw new Error("mori: close()된 session에는 더 이상 prompt()를 호출할 수 없습니다.");
        }

        const before = agent.state.messages.length;
        await agent.prompt(text);
        const replies = agent.state.messages
          .slice(before)
          .filter((message): message is AssistantMessage => message.role === "assistant");
        const last = replies.at(-1);

        return {
          text: last ? contentText(last.content) : "",
          stopReason: last?.stopReason ?? "error",
          usage: sumUsage(replies.map((reply) => reply.usage)),
        };
      },

      consolidate(signal?: AbortSignal): Promise<ExplicitConsolidateOutcome> {
        return consolidateExplicit(kernel, llm, signal);
      },

      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        // Same ordering as runPrompt's finally (cli/runtime.ts): drain queued observations
        // before the session-end trigger, so the boundary sees everything this episode did.
        await kernel.drain();
        await consolidateOnSessionEnd(kernel, sessionEndLlm(llm, projectId), stderr);
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
 */
function sumUsage(usages: Usage[]): Usage {
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

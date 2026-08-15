import {
  DEFAULT_COMPACTION_SETTINGS,
  generateSummaryWithUsage,
  type MessageEntry,
} from "@earendil-works/pi-agent-core";
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

/** Options for `MoriSession.compact()` (#464). */
export interface MoriSessionCompactOptions {
  /**
   * Bypasses pi's `keepRecentTokens` (20000) tail-retention split and summarizes the entire
   * current context in one call, instead of the default `agent.compact()` path. Opt-in only
   * — omitting this leaves `compact()` byte-for-byte what it did before this option existed
   * (정본 방어선: production's context-window-triggered compaction, `compactIfContextFull` in
   * cli/compaction.ts, never sets this and is unaffected).
   *
   * Why this exists: pi's `compact()` only summarizes the part of the conversation OLDER than
   * `keepRecentTokens` and leaves the rest as a verbatim `retainedTail` it does not hand to
   * the caller. A conversation shorter than that budget (the preference-regression bench's
   * few-turn context sessions, #462) has NOTHING older than the budget, so
   * `messagesToSummarize` comes back empty and the summarizer answers "the conversation is
   * empty" — a non-empty string that every downstream consumer reads as a real summary.
   */
  forceCut?: boolean;
}

/** What a single `MoriSession.close()` call produced (#449). */
export interface MoriSessionClose {
  /**
   * Usage of the session-end consolidation boundary's own distillation LLM call — zero when
   * consolidation is unconfigured, the boundary was a no-op (nothing to distill), or the
   * boundary failed before the extraction call (`consolidateOnSessionEnd` swallows that
   * failure, same as before this field existed). This is the number PR #448 §5-a found
   * missing from every ledger: `close()`'s session-end distillation call previously landed
   * in no caller's cost accounting at all.
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
   * context window fills, triggered by the caller instead of by the threshold. Without
   * `options.forceCut`, the compaction path stays entirely pi's default: mori declares no
   * summary prompt and no second threshold of its own (정본 문서 §6.1), and this method adds
   * neither — that is still true WITH `forceCut` (#464), which reuses pi's own summarizer
   * (`generateSummaryWithUsage`) rather than declaring a mori-side one.
   *
   * Its callers are the preference-regression OFF/ON-fallback arms
   * (bench/preference-regression/runner.ts, #434, #459) — always with `forceCut: true`
   * (#462: their context sessions are too short for pi's default tail-retention split to ever
   * produce a real summary; see `MoriSessionCompactOptions.forceCut`). "What would have
   * survived the session's death if mori were not here?" has exactly one honest answer — a
   * real compaction summary, not a "the conversation is empty" boilerplate — and handing that
   * answer to the follow-up session requires getting it out of the session it was made in.
   *
   * Queues behind whatever `prompt()`/`consolidate()`/`close()` call is in flight, same
   * ordering as `prompt()`: without `forceCut`, `compact()` requires an idle harness
   * (cli/compaction.ts) and rejects with `busy` if it lands mid-turn.
   *
   * Rejects rather than reporting through `stderr`, unlike the between-turns trigger. That
   * trigger's failure is benign (the context is merely still too big and the next turn
   * re-measures), but this caller asked for the summary itself — quietly answering with an
   * empty one would let the OFF arm report "it saw a compaction summary" when it saw nothing.
   *
   * @remarks
   * `forceCut: true`는 **세션 엔트리를 갱신하지 않는다** — 요약 텍스트만 만들어 반환할 뿐
   * `appendCompaction()`도 `session_compact` emit도 하지 않는다. 따라서 이 옵션은
   * **호출 직후 세션을 버리는 용도(벤치 등)에서만 안전하다.** 압축 후에도 세션을 계속
   * 쓰려면 옵션 없는 기본 경로(`compact()`)를 써라.
   *
   * 가드는 `prompt()`에만 있다. `close()`는 forceCut의 의도된 종착점(요약만 뽑고 세션을
   * 버림)이므로 막을 대상이 아니다. `consolidate()`도 막히지 않는다 — 이 세션의 원본
   * 엔트리는 forceCut 후에도 그대로 남아 있어 `consolidate()` 자체는 실패하지 않지만,
   * forceCut이 이미 같은 내용을 요약해 반환했으므로 **직접 부르지 마라**: 원본 엔트리를
   * 다시 증류해 forceCut의 요약과 중복되는 결과를 만들 뿐이다 (#466).
   *
   * 입력 크기: forceCut은 pi의 토큰 예산 계산·슬라이싱(`prepareCompaction`)을 건너뛰고
   * `contextMessages()` 전체를 요약기에 한 번에 넘긴다 — 매우 긴 세션이면 이론상 요약
   * 모델의 컨텍스트 한도를 넘길 수 있다. 가드를 두지 않기로 했다: forceCut은 애초에
   * `prompt()`가 막는 "일회용, 호출 직후 세션을 버리는" 경로 전용이고, 현재 유일한
   * 호출부(bench/preference-regression/runner.ts)는 3~4턴짜리 짧은 맥락 세션만 이 옵션을
   * 쓴다. 이 전제가 깨지면(긴 세션에 forceCut을 쓰는 새 호출부가 생기면) 그때 가서
   * 명확한 에러로 거부하는 가드를 추가하되, 조용히 잘라내는 구현은 금지한다 — #462가
   * 정확히 「요약기가 받은 것이 기대와 다른데 아무도 모른다」였다 (#466).
   */
  compact(options?: MoriSessionCompactOptions): Promise<MoriSessionCompaction>;
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
   *
   * Resolves with the session-end boundary's own usage (#449, `MoriSessionClose`) — before
   * this, the distillation LLM call `close()` makes internally spent tokens no caller could
   * see. Every concurrent/repeat caller gets the SAME `MoriSessionClose`, matching the
   * "shares the same underlying settle" guarantee above.
   */
  close(): Promise<MoriSessionClose>;
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
  let closePromise: Promise<MoriSessionClose> | undefined;
  // Set once `compact({ forceCut: true })` has run (#464 owner review round 2): that path
  // never appends the compaction to the session's own entry log (see `compact()`'s
  // `@remarks`), so a later `prompt()` on this session would silently resend the full
  // pre-compaction history while believing it had been summarized away.
  let forceCutUsed = false;

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
        if (forceCutUsed) {
          throw new Error(
            "prompt() after compact({ forceCut: true }): forceCut leaves the session's entries " +
              "unchanged, so this turn would resend the full pre-compaction history. Start a new " +
              "session, or use compact() without forceCut.",
          );
        }

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

      async compact(options?: MoriSessionCompactOptions): Promise<MoriSessionCompaction> {
        // `async` for the same reason `consolidate()` is: `assertOpen`'s throw has to reject
        // the returned promise, not escape synchronously.
        assertOpen("compact");
        // Set synchronously, before `enqueue` — same reasoning as `closePromise` above: a
        // caller that fires `compact({ forceCut: true })` without awaiting it and immediately
        // calls `prompt()` (no `await` in between) must still have `prompt()`'s own synchronous
        // guard (below) see this set. Setting it from inside the enqueued callback instead would
        // leave that unawaited-call race open — `prompt()`'s guard runs before its own work is
        // enqueued, so it would run ahead of a `forceCut` branch that hadn't started yet.
        const forceCutUsedBeforeThisCall = forceCutUsed;
        if (options?.forceCut) forceCutUsed = true;

        return enqueue(async () => {
          if (!options?.forceCut) {
            const result = await agent.compact();
            // `usage` is optional on `CompactResult` — a provider that reports none must read
            // as "this cost nothing we can see", not as a missing field the caller has to
            // handle.
            return { summary: result.summary, usage: result.usage ?? ZERO_USAGE };
          }

          // `forceCut` (#464): `agent.compact()` goes through pi's `prepareCompaction` ->
          // `compact()`, which SPLITS the context into `messagesToSummarize` (older than
          // `keepRecentTokens`, the only part that gets summarized) and `retainedTail`
          // (everything else, kept verbatim and never handed to this caller). A conversation
          // shorter than `keepRecentTokens` has nothing older than the budget, so that split
          // leaves `messagesToSummarize` empty and pi's summarizer answers "the conversation is
          // empty" — the diagnosed bug (#462).
          //
          // The fix bypasses that split entirely: `contextMessages()` is the full message list
          // the harness would send the NEXT turn (agent/index.ts), and it goes straight into
          // `generateSummaryWithUsage` — the exact function pi's own `compact()` calls
          // internally on `messagesToSummarize` (pi 0.82.1
          // harness/compaction/compaction.ts's `compact()`), just handed the whole
          // conversation instead of a possibly-empty slice of it. This is a deliberate choice
          // between the two options the issue left open: carry the split summary alongside a
          // separately-serialized `retainedTail`, or summarize everything in one call. The
          // latter was picked because it needs no second carryover format for the tail — the
          // summary itself is guaranteed to cover every context turn, which is what a
          // follow-up session actually needs (#464 요구사항).
          try {
            // `try` starts here (before `contextMessages()`, not just around the summarizer
            // call) because the completion condition is "forceCut compaction fails", not
            // "the summarizer call fails" — `contextMessages()` (`Session.buildContext()`
            // internally) is still part of what a forceCut compaction does, so a throw from
            // it must restore the flag exactly like a summarizer failure does (owner review,
            // PR #467 round 2).
            const messages = await agent.contextMessages();
            const summaryResult = await generateSummaryWithUsage(
              messages,
              agent.models,
              agent.getModel(),
              DEFAULT_COMPACTION_SETTINGS.reserveTokens,
            );
            if (!summaryResult.ok) throw summaryResult.error;
            // Confirm the lock at the point of success, not just rely on the synchronous set
            // above — two unawaited `compact({ forceCut: true })` calls on the same session
            // enqueue back-to-back with their own `forceCutUsedBeforeThisCall` snapshot; if one
            // fails and restores the flag while the other is still in flight, that restore must
            // not erase a forceCut that actually happened. Setting it again here means the
            // surviving success always wins over an unrelated call's restore, whichever order
            // they settle in.
            forceCutUsed = true;
            return { summary: summaryResult.value.text, usage: summaryResult.value.usage };
          } catch (error) {
            // #466: if the forceCut compaction fails (network/rate-limit, or any other throw
            // from the callback above), the session's entries are exactly as untouched as if
            // `compact()` had never been called, so `prompt()`'s "resend full pre-compaction
            // history" guard must not apply. Restored to whatever the flag was BEFORE this call
            // set it, not unconditionally `false` — an earlier successful forceCut compaction
            // on this same session must stay locked.
            forceCutUsed = forceCutUsedBeforeThisCall;
            throw error;
          }
        });
      },

      close(): Promise<MoriSessionClose> {
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
          // Usage capture (#449): `consolidateGuarded` (cli/consolidation.ts) serializes every
          // boundary on this kernel onto one chain, so no OTHER trigger's extraction call can
          // be in flight while this one runs — accumulating every `onUsage` firing during this
          // one `consolidateOnSessionEnd` call is therefore exactly this boundary's own usage,
          // never another boundary's. `sumUsage` (not last-write) because nothing in the
          // extractor contract promises exactly one `complete()` call per boundary.
          const usages: Usage[] = [];
          await consolidateOnSessionEnd(kernel, sessionEndLlm(llm, projectId), stderr, (usage) => {
            usages.push(usage);
          });
          return { usage: sumUsage(usages) };
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

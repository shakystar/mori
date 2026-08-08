/**
 * Where mori decides WHEN to compact its context, and what happens once a compaction has
 * landed (#409, docs/agent-harness-adoption.md §Q7 조각 E). The sibling of
 * `consolidation.ts`: that file owns the boundaries of the MEMORY axis, this one owns the
 * trigger of the CONVERSATION axis and the one place where the second hands off to the first.
 *
 * Both halves live here because they are one decision. The harness never compacts on its own
 * (§Q1 ①) — `AgentHarness.compact()` exists and nothing calls it — so until this file there
 * was no compaction in mori at all, and therefore no `post-compact` consolidation boundary
 * either.
 */

import {
  AgentHarnessError,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  shouldCompact,
} from "@earendil-works/pi-agent-core";
import type { ConsolidatorLlm } from "@mori/kernel";
import type { MoriAgent, MoriKernel } from "../agent/index.js";
import { consolidateAfterCompact } from "./consolidation.js";

/**
 * The between-turns compaction trigger, and the only `compact()` call site in mori.
 *
 * Called after a turn settles, never during one: `compact()` requires an idle harness (see
 * the `busy` branch below), and the estimate is only meaningful once the turn's own reply —
 * the message carrying the provider's usage report — is in the session.
 *
 * ## The threshold is pi's, and there is exactly one of it
 *
 * `estimateContextTokens` + `shouldCompact` + `DEFAULT_COMPACTION_SETTINGS`, all three from
 * pi, against the selected model's own `contextWindow`. mori declares no number of its own
 * (정본 문서 §6.1 — no second threshold): the memory kernel's `threshold` consolidation
 * trigger is a different axis, and how the two should relate is a decision that waits on
 * measurements this trigger is what first makes possible.
 *
 * `contextMessages()` (agent/index.ts) rather than `getEntries()`, because the question is
 * "how big is the context the NEXT turn would send" — which after a compaction is summary +
 * `retainedTail`, not the entry log that still holds everything.
 *
 * ## Failure is reported, not propagated
 *
 * Compaction is an upkeep step attached to a turn that has already succeeded. A REPL session
 * (or a benchmark episode, session.ts) must not end because the summary request failed, so
 * every failure is reported through `onError` and the loop goes on to the next turn — the
 * context is merely still too big, which is exactly the state the next turn re-measures.
 */
export async function compactIfContextFull(
  agent: MoriAgent,
  onError: (message: string) => void,
): Promise<void> {
  const messages = await agent.contextMessages();
  const estimate = estimateContextTokens(messages);
  if (!shouldCompact(estimate.tokens, agent.getModel().contextWindow, DEFAULT_COMPACTION_SETTINGS))
    return;

  try {
    await agent.compact();
  } catch (error) {
    // `compact()` rejects with `busy` when the harness is not idle (`phase !== "idle"`) —
    // reachable when something else drives the same harness concurrently (an `abort()` still
    // unwinding, a `steer`/`followUp` run the SDK caller started). Swallowed on purpose and
    // deliberately not retried here: the context is unchanged, so the next turn's own
    // estimate reaches the same verdict and fires this again. Waiting for idle instead would
    // hold up the caller's turn loop for a compaction that has no deadline.
    if (error instanceof AgentHarnessError && error.code === "busy") return;
    onError(compactFailureMessage(error));
  }
}

/**
 * Subscribes the `post-compact` consolidation boundary (정본 문서 §6.2) to the harness's
 * compaction notification. Returns the unsubscribe function `subscribe` hands out.
 *
 * ## `subscribe`, not `on`
 *
 * `session_compact` is available both ways, and this is deliberately the observer half
 * (§Q1 ②): `subscribe` is a broadcast to listeners that cannot alter what happened, whereas
 * the `on(...)` hook family holds decision power over compaction itself
 * (`session_before_compact` can cancel it or substitute the summary). A memory boundary is a
 * consequence of compaction, not a participant in it. Registering both would also fire the
 * boundary twice per compaction, which no watermark would undo (see `consolidation.ts`).
 *
 * ## This boundary distills OBSERVATIONS ONLY — that is not a regression, and not a bug
 *
 * The conversation text that compaction just cut out of the context does not reach the
 * kernel, here or anywhere: the boundary takes no conversation argument. Do not "fix" that by
 * pushing `compactionEntry.retainedTail` (or the summary) into `kernel.consolidate` — there is
 * no parameter for it, and the seam that would carry it is `ConversationSource`, a PULL seam
 * that a push cannot be poured into. The kernel names this configuration itself: a missing
 * `ConversationSource` is "an observation-only boundary, which is the pre-existing degraded
 * behaviour, not an error" (`packages/kernel/src/index.ts`).
 *
 * So the count of conversation text this boundary hands the kernel is zero, and it was zero
 * before compaction existed too (정본 문서 §5.2 R5) — this trigger neither loses nor gains
 * anything on that axis. The text itself is not destroyed: session entries are append-only,
 * so what compaction dropped from the CONTEXT is still in the session's entry log
 * (`getEntries`, §Q3). Wiring that log to the kernel is the follow-on `ConversationSource`
 * piece, which has its own decision to make first (push parameter vs. pull adapter) and is
 * explicitly not this one.
 *
 * ## The boundary is not awaited
 *
 * `subscribe` awaits its listeners, so awaiting the boundary here would make `compact()` —
 * and with it the turn loop that called it — wait for an extraction LLM call (정본 문서 §1 D1
 * says it must not). Not awaiting means this caller owns the rejection sink for the promise
 * it drops (§6.3 D7, the same discipline `repl.ts` applies to `abort()`), which is the
 * `.catch` below; without it a failing boundary would take the process down as an unhandled
 * rejection.
 *
 * `llm` is a getter, not a value, because what it answers changes DURING a session:
 * `runtime.ts`'s `sessionEndLlm` reports `undefined` until the on-disk store exists, and the
 * store is created by the first observation that passes the capture filter. Read once at
 * subscription time — session start, before any turn — it would be `undefined` for every
 * session that had not already written to disk, silently disabling this boundary in exactly
 * the sessions long enough to compact.
 */
export function subscribePostCompactConsolidation(
  agent: MoriAgent,
  kernel: MoriKernel,
  llm: () => ConsolidatorLlm | undefined,
  onError: (message: string) => void,
): () => void {
  return agent.subscribe((event) => {
    if (event.type !== "session_compact") return;
    void consolidateAfterCompact(kernel, llm()).catch((error: unknown) => {
      onError(postCompactFailureMessage(error));
    });
  });
}

function compactFailureMessage(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `mori: 컨텍스트 압축에 실패했습니다 (다음 턴에 다시 시도합니다) — ${reason}\n`;
}

function postCompactFailureMessage(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `mori: 압축 이후 증류에 실패했습니다 (다음 경계에서 같은 구간을 다시 시도합니다) — ${reason}\n`;
}

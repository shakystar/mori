/**
 * Where mori decides WHEN to call `kernel.consolidate(llm)` (#107). #106 built the LLM,
 * #12 built the kernel that does something with it — nothing before this file ever called
 * it.
 *
 * Two triggers, both harness-side (`runtime.ts`'s `runPrompt` finally, `index.ts`'s REPL
 * exit finally, and this file's `/consolidate` handler for `repl.ts`): session end and an
 * explicit user request. `consolidate-service`'s watermark is an idempotency device for
 * SEQUENTIAL boundaries, not a concurrency guard (its own module doc says so) — two
 * overlapping calls would each read the same watermark and both append. `consolidateGuarded`
 * below is what keeps that from happening: a per-kernel promise chain that makes the second
 * caller's real `consolidate()` wait for the first one to finish, rather than skipping it.
 * Serialize, not single-flight — a session-end boundary that arrives while an explicit one is
 * still running must still run for real once its turn comes, or work the user asked for by
 * name would be silently dropped.
 */

import type { ConsolidatorLlm } from "@mori/kernel";
import type { MoriKernel } from "../agent/index.js";

/**
 * One in-flight (or most recently chained) consolidation per kernel instance. A `WeakMap`
 * rather than a field on the kernel itself, because `MoriKernel` is the replaceable seam
 * (agent/index.ts) — this guard is a harness-lifecycle concern, the same reasoning that kept
 * `drain` off `MemoryKernel` and on `MoriKernel` instead.
 */
const chains = new WeakMap<MoriKernel, Promise<void>>();

/**
 * Chains `kernel.consolidate(llm)` onto whatever the same kernel's previous call (if any) is
 * still doing, so two overlapping triggers run one after the other instead of racing. A
 * caller's own rejection is still visible to it — only the CHAINING waits on a settled prior
 * call, an earlier failure must not permanently wedge every later trigger.
 */
function consolidateGuarded(kernel: MoriKernel, llm: ConsolidatorLlm): Promise<void> {
  const prior = chains.get(kernel) ?? Promise.resolve();
  const mine = prior.catch(() => {}).then(() => kernel.consolidate(llm));
  chains.set(
    kernel,
    mine.catch(() => {}),
  );
  return mine;
}

/**
 * Session-end trigger. A no-op when consolidation is unconfigured (`llm` undefined) — the
 * same "absent seam degrades quietly" contract `Embedder` already follows. Never throws: a
 * boundary failure is reported through `onError` and otherwise ignored, because the process
 * is about to exit and the watermark not advancing means the next boundary just retries this
 * same window.
 */
export async function consolidateOnSessionEnd(
  kernel: MoriKernel,
  llm: ConsolidatorLlm | undefined,
  onError: (message: string) => void,
): Promise<void> {
  if (!llm) return;
  try {
    await consolidateGuarded(kernel, llm);
  } catch (error) {
    onError(sessionEndFailureMessage(error));
  }
}

function sessionEndFailureMessage(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `mori: 세션 종료 시 증류에 실패했습니다 (다음 세션에서 같은 구간을 다시 시도합니다) — ${reason}\n`;
}

/** What an explicit, user-requested consolidation attempt did. */
export type ExplicitConsolidateOutcome =
  { kind: "skipped" } | { kind: "ok" } | { kind: "failed"; error: unknown };

/**
 * Explicit-invocation trigger (the REPL's `/consolidate`, `repl.ts`). Unlike the session-end
 * trigger, failure is not swallowed — the user asked for this by name, so the caller gets an
 * outcome to report rather than silence.
 */
export async function consolidateExplicit(
  kernel: MoriKernel,
  llm: ConsolidatorLlm | undefined,
): Promise<ExplicitConsolidateOutcome> {
  if (!llm) return { kind: "skipped" };
  try {
    await consolidateGuarded(kernel, llm);
    return { kind: "ok" };
  } catch (error) {
    return { kind: "failed", error };
  }
}

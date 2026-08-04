import type { StartupContextPayload } from "../domain/entities.js";
import type { Embedder } from "../index.js";
import { fitInjectionBudget } from "./injection-budget.js";
import {
  retrieveMemoryContext,
  retrieveSegments,
  type RetrievedSegment,
} from "./memory-retrieval-service.js";
import { semanticMemoryScores } from "./search-service.js";

/**
 * Tight embed budget at SessionStart — the network must never block boot.
 *
 * Declared here (it is a kernel-boundary policy, not a transport detail) but
 * APPLIED by the harness: the kernel no longer builds embedders (#82), so the
 * caller is the one that must construct the SessionStart `Embedder` with this
 * timeout baked in before passing it to `buildMemoryContext`.
 */
export const SESSION_START_EMBED_TIMEOUT_MS = 5_000;

export type MemoryContext = Pick<
  StartupContextPayload,
  "rawSegments" | "consolidatedMemories" | "recentObservations"
>;

/**
 * Kernel-scope slice of upstream memorize's `loadStartContext`: the
 * freshness/relevance-ranked memory context assembly (P3-c semantic boost +
 * CLS two-layer retrieval + raw-segment channel). Retrieval-only — it does NOT
 * reinforce what it retrieves (mori#176); see the reinforcement note further
 * down for why that is the caller's job. Everything else upstream's
 * `loadStartContext` also assembles (project/workstream/task/handoff/
 * checkpoint, other-active-tasks, personal and shared memory channels,
 * inbound task requests) reads through project-service/session-service/
 * task-service/workspace-service/personal-store-service — host-CLI product
 * services with no kernel consumer yet, so they stay out of this port
 * (mori#63).
 */
export async function buildMemoryContext(
  projectId: string,
  opts: { taskTitle?: string; embedder?: Embedder } = {},
): Promise<MemoryContext> {
  // Embed the task title ONCE, up front, and reuse the vector across both
  // the memory (P3-c) and segment (raw-detail) retrieval paths below. The
  // two paths used to each resolve their own embedder and embed the same
  // title independently — two sequential network calls, each against the
  // SESSION_START_EMBED_TIMEOUT_MS budget, so a slow/unresponsive endpoint
  // could block SessionStart for roughly double the stated timeout (mori#63
  // review). Sharing one embedder + one query vector (or none, on failure —
  // no retry) keeps the wall-clock bound to a single embed call.
  //
  // The embedder is INJECTED (#82) rather than resolved from env here: absence
  // is a caller decision and degrades both channels to FTS-only, which is the
  // exact behavior the old unconfigured-env path produced.
  const embedder = opts.taskTitle ? opts.embedder : undefined;
  let queryVec: number[] | undefined;
  if (opts.taskTitle && embedder) {
    try {
      [queryVec] = await embedder.embed([opts.taskTitle]);
    } catch {
      queryVec = undefined; // best-effort — both channels fall back to FTS-only below.
    }
  }

  // P3-c — semantic relevance boost: score memories by cosine similarity to
  // the shared query vector (graded boost in retrieveMemoryContext).
  // Best-effort; degrades to FTS-only when no embedder was injected or the
  // embed above failed/timed out.
  let semanticScores: Map<string, number> | undefined;
  if (opts.taskTitle && queryVec) {
    try {
      const scores = await semanticMemoryScores(projectId, opts.taskTitle, embedder, queryVec);
      if (scores.size > 0) semanticScores = scores;
    } catch {
      // best-effort — fall back to FTS relevance only.
    }
  }

  // CLS two-layer retrieval: rank consolidated memories + the previous
  // session's observation tail in one pool. Deliberately retrieval-only —
  // this function does NOT reinforce (mori#176). Reinforcement stamps
  // `last_accessed_at`/`injection_count`, which is only true once a caller has
  // actually put the result in front of the model; `buildMemoryContext` has no
  // way to know that (its result may be discarded, e.g. a harness render
  // failure), so the caller that confirms injection — `SqliteMemoryKernel.
  // transformContext` — calls `reinforceInjectedMemories` itself, after render
  // succeeds.
  const retrieved = retrieveMemoryContext(projectId, {
    ...(opts.taskTitle ? { taskTitle: opts.taskTitle } : {}),
    ...(semanticScores ? { semanticScores } : {}),
  });

  // Raw-detail channel: verbatim transcript segments for the task, surfaced
  // ALONGSIDE consolidated memories with their own budget. Best-effort; empty
  // without a task title or segments. Reuses the query vector computed above
  // — no separate embed call — and, without one (no embedder, or the embed
  // above failed), leaves the embedder unset too so this channel degrades to
  // FTS instead of retrying the same embed that just failed.
  let rawSegments: RetrievedSegment[] = [];
  if (opts.taskTitle) {
    try {
      rawSegments = await retrieveSegments(projectId, {
        taskTitle: opts.taskTitle,
        ...(queryVec && embedder ? { embedder, queryVec } : {}),
      });
    } catch {
      // best-effort — segments are augmentative.
    }
  }

  // #238 — the canonical injection ceiling, enforced ONCE, here, over the
  // rendered block. The channel budgets applied above are retrieval-stage
  // pre-trims on raw text; this is the judgement on what is actually sent, and
  // assembling the payload is part of it (the trim drops entries, which changes
  // which channels appear at all). Nothing downstream re-budgets — see
  // `injection-budget.ts` for why the enforcement point is this one.
  return fitInjectionBudget({ ranked: retrieved.ranked, segments: rawSegments });
}

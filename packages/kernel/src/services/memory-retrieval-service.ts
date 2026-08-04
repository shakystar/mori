import type { Observation } from "../domain/entities.js";
import { nowIso } from "../domain/common.js";
import type { Embedder } from "../index.js";
import type { MemoryRecord } from "../projections/projector.js";
import {
  listRecentObservations,
  listValidMemories,
  touchMemoryAccess,
} from "./projection-store.js";
import { hybridSearchSegments, searchProject } from "./search-service.js";
import { listSegmentTexts } from "./segment-store.js";

/**
 * CLS Phase 1 — retrieval-time ranking for startup injection (decision ②,
 * 2026-06-08: single pool + per-layer weight coefficients).
 *
 * Forgetting is retrieval-time ONLY (D4): nothing is deleted, low scores
 * just fall outside the budget. Decay is deterministic (createdAt-based);
 * reinforcement (lastAccessedAt) is the projection-level signal that bumps
 * effective recency when present, and is absent until a memory has been
 * injected at least once.
 *
 * Every constant below is a TUNING PARAMETER (start values from the
 * 2026-06-08 decisions) — adjust against real transcripts, not in advance.
 */
export const LONG_TERM_WEIGHT = 0.7;
export const SHORT_TERM_WEIGHT = 0.3;
/**
 * Char budget for the combined memory+observation pool — a RETRIEVAL-STAGE
 * pre-trim over raw stored text, not the ceiling on what gets injected.
 *
 * The canonical ceiling is `INJECTION_BUDGET_TOKENS` (`injection-budget.ts`),
 * which is enforced once, in tokens, over the RENDERED block. This constant
 * only keeps the pool this function ranks from growing without bound before
 * that judgement runs.
 *
 * #238 — the doc here used to claim this budget "sits INSIDE the renderer's
 * overall MAX_STARTUP_CONTEXT_CHARS (8000)". No such identifier ever existed
 * anywhere in the repo: nothing enforced a combined ceiling, and the comment
 * describing the layer that would have hid its absence.
 */
export const MEMORY_POOL_BUDGET_CHARS = 4000;
/** Recency half-life for the exponential decay term, in days. */
export const RECENCY_HALF_LIFE_DAYS = 14;
/** Short-term tail window: most recent N observations within MAX_AGE. */
export const OBSERVATION_TAIL_LIMIT = 20;
export const OBSERVATION_TAIL_MAX_AGE_HOURS = 24;
/** Additive boost when FTS relevance links a memory to the current task. */
export const RELEVANCE_BOOST = 0.3;

export interface RankedMemory {
  memory: MemoryRecord;
  score: number;
}

/**
 * One selected pool entry, tagged with the channel it came from.
 *
 * Memories and observations are ranked TOGETHER by `score` (that is what the
 * layer weights are for), and splitting them into two arrays throws that
 * interleaving away. #238's budget trim has to drop the lowest-scoring entry
 * first regardless of channel, so the selection order is carried out of here
 * instead of being re-derived — re-deriving it would mean a second copy of the
 * ranking, which this issue explicitly must not change.
 */
export type RankedPoolEntry =
  | { channel: "memory"; memory: RankedMemory }
  | { channel: "observation"; observation: Observation };

export interface RetrievedMemoryContext {
  /**
   * The selected pool in ranked order, best first — the single source the two
   * channel arrays below are derived views of.
   */
  ranked: RankedPoolEntry[];
  memories: RankedMemory[];
  observations: Observation[];
}

function recencyScore(referenceIso: string, nowMs: number): number {
  const ageMs = Math.max(0, nowMs - Date.parse(referenceIso));
  const ageDays = ageMs / 86_400_000;
  // exp decay scaled so score = 0.5 at exactly one half-life.
  return Math.exp((-Math.LN2 * ageDays) / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Rank the long-term and short-term layers in ONE pool and take the best
 * entries that fit the char budget. Layer weights (not split budgets) are
 * what bias the mix toward consolidated meaning over raw tail.
 */
export function retrieveMemoryContext(
  projectId: string,
  opts: {
    /** Current task title — drives the FTS relevance boost when present. */
    taskTitle?: string;
    /** ISO timestamp for deterministic tests; defaults to now. */
    nowIso?: string;
    /**
     * P3-c — optional id→cosine-similarity (in [0,1]) for the task, computed by
     * the caller (async, best-effort). When present, a GRADED semantic boost
     * (RELEVANCE_BOOST × similarity) replaces/augments the binary FTS boost. When
     * absent (no embeddings endpoint, or the embed timed out), ranking is exactly
     * the pre-P3-c FTS behavior.
     */
    semanticScores?: Map<string, number>;
  } = {},
): RetrievedMemoryContext {
  const nowMs = Date.parse(opts.nowIso ?? nowIso());

  // Relevance: which valid memories match the current task title?
  let relevantIds = new Set<string>();
  if (opts.taskTitle) {
    relevantIds = new Set(
      searchProject(projectId, opts.taskTitle)
        .filter((hit) => hit.kind === "memory")
        .map((hit) => hit.entityId),
    );
  }

  interface PoolEntry {
    score: number;
    chars: number;
    memory?: RankedMemory;
    observation?: Observation;
  }
  const pool: PoolEntry[] = [];

  for (const row of listValidMemories(projectId)) {
    const { memory, lastAccessedAt } = row;
    // Reinforcement: a re-referenced memory decays from its last access, not
    // its creation. Never-injected memories have no stamp and decay from
    // createdAt.
    const reference =
      lastAccessedAt && lastAccessedAt > memory.createdAt ? lastAccessedAt : memory.createdAt;
    const base = 0.5 * (memory.salience / 10) + 0.5 * recencyScore(reference, nowMs);
    // Relevance boost: take the stronger of the binary FTS signal and the
    // graded semantic signal (when P3-c embeddings are configured). No semantic
    // scores → identical to the pre-P3-c FTS-only boost.
    const ftsBoost = relevantIds.has(memory.id) ? RELEVANCE_BOOST : 0;
    const semBoost = opts.semanticScores
      ? RELEVANCE_BOOST * Math.max(0, opts.semanticScores.get(memory.id) ?? 0)
      : 0;
    const score = LONG_TERM_WEIGHT * (base + Math.max(ftsBoost, semBoost));
    pool.push({
      score,
      chars: memory.text.length + 24,
      memory: { memory, score },
    });
  }

  const sinceIso = new Date(nowMs - OBSERVATION_TAIL_MAX_AGE_HOURS * 3_600_000).toISOString();
  for (const observation of listRecentObservations(projectId, {
    limit: OBSERVATION_TAIL_LIMIT,
    sinceIso,
  })) {
    const score = SHORT_TERM_WEIGHT * recencyScore(observation.createdAt, nowMs);
    pool.push({
      score,
      chars: (observation.summary?.length ?? 16) + 24,
      observation,
    });
  }

  pool.sort((a, b) => b.score - a.score);
  const ranked: RankedPoolEntry[] = [];
  let spent = 0;
  for (const entry of pool) {
    if (spent + entry.chars > MEMORY_POOL_BUDGET_CHARS) continue;
    spent += entry.chars;
    if (entry.memory) ranked.push({ channel: "memory", memory: entry.memory });
    else if (entry.observation)
      ranked.push({ channel: "observation", observation: entry.observation });
  }

  // The channel arrays are VIEWS of `ranked`, built here rather than filled in
  // the loop above so the ranked order stays the one thing that decides both
  // what is in each channel and in what order.
  return {
    ranked,
    memories: ranked.flatMap((entry) => (entry.channel === "memory" ? [entry.memory] : [])),
    observations: ranked.flatMap((entry) =>
      entry.channel === "observation" ? [entry.observation] : [],
    ),
  };
}

/**
 * Max raw segments pulled per query, and their own retrieval-stage char budget
 * — SEPARATE from {@link MEMORY_POOL_BUDGET_CHARS} so segments can never evict
 * consolidated memories at retrieval time. Like that constant, this is a
 * pre-trim over raw text, not the injection ceiling: `INJECTION_BUDGET_TOKENS`
 * (`injection-budget.ts`) is the final judge, and it drops segments first for
 * the same reason this budget is separate.
 */
export const SEGMENT_CHANNEL_LIMIT = 6;
export const SEGMENT_POOL_BUDGET_CHARS = 2000;

export interface RetrievedSegment {
  id: string;
  text: string;
}

/**
 * Raw-detail channel (v10): hybrid-search the `segment` corpus for the current
 * task and return full-text segments within their OWN budget. Independent of the
 * memory/observation pool. Empty when there is no task title or no segments.
 * Async because it may embed the query (shared `queryVec` avoids a second embed).
 */
export async function retrieveSegments(
  projectId: string,
  opts: {
    taskTitle?: string;
    embedder?: Embedder;
    queryVec?: number[];
    budgetChars?: number;
  } = {},
): Promise<RetrievedSegment[]> {
  if (!opts.taskTitle?.trim()) return [];
  const hits = await hybridSearchSegments(
    projectId,
    opts.taskTitle,
    SEGMENT_CHANNEL_LIMIT,
    opts.embedder,
    opts.queryVec,
  );
  if (hits.length === 0) return [];
  const texts = listSegmentTexts(projectId);
  const budget = opts.budgetChars ?? SEGMENT_POOL_BUDGET_CHARS;
  const out: RetrievedSegment[] = [];
  let spent = 0;
  for (const hit of hits) {
    const text = texts.get(hit.entityId) ?? hit.snippet;
    if (!text) continue;
    if (spent + text.length > budget) continue;
    spent += text.length;
    out.push({ id: hit.entityId, text });
  }
  return out;
}

/**
 * Reinforcement stamp for the memories that were actually injected.
 * Projection-only UPDATE — events stay append-only.
 *
 * Takes ids rather than `RankedMemory[]` (mori#176): the caller that actually
 * knows injection succeeded is the harness-facing kernel seam, which only has
 * the flattened {@link MemoryContext} shape, not the ranked retrieval pool.
 */
export function reinforceInjectedMemories(projectId: string, memoryIds: string[]): void {
  touchMemoryAccess(projectId, memoryIds, nowIso());
}

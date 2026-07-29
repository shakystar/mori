import type { ConsolidatorLlm } from "../index.js";
import type { Embedder } from "../index.js";
import { createConflict, type Conflict } from "../domain/entities.js";
import type { MemoryRecord } from "../projections/projector.js";
import { cosineSimilarity } from "./embeddings-service.js";
import { listEmbeddings } from "./embeddings-store.js";
import { listValidMemories, rebuildProjectProjection } from "./projection-store.js";
import { appendEvent } from "../storage/event-store.js";

/**
 * Semantic contradiction detection between `decision`-kind memories — an
 * embedding cosine prefilter (cheap, exact) narrows the O(n^2) pair space
 * down to the plausible few, and an injected `Judge` (normally
 * `makeLlmJudge`) makes the actual semantic call on each survivor. On a
 * confirmed contradiction: the loser is invalidated via `memory.superseded`
 * (bi-temporal, D4 — never deleted) and a `Conflict` is raised via
 * `conflict.detected` so the agent surfaces it.
 *
 * The LLM judge decides ONLY whether two memories contradict — never which
 * one wins. The winner is the deterministic (createdAt, id) tie-break
 * documented on the `Conflict.concurrent` field, so every replica converges
 * on the same outcome without depending on the (non-deterministic) LLM call.
 */

/** Prefix on every `memory.superseded` reason produced by this module, so a
 *  reader (or a future `memory-telemetry-service`) can distinguish a
 *  semantic-contradiction supersede from any other invalidation path. */
export const SEMANTIC_CONTRADICTION_REASON_PREFIX = "semantic-contradiction: ";

/** Cosine-similarity floor before a pair is even sent to the judge (tuning
 *  parameter — narrows the O(n^2) pair space to plausible near-duplicates /
 *  restatements; below this two decisions are assumed unrelated). */
export const DEFAULT_COSINE_THRESHOLD = 0.85;

export interface JudgeCandidate {
  id: string;
  text: string;
}

export interface JudgePair {
  a: JudgeCandidate;
  b: JudgeCandidate;
}

export interface JudgeVerdict {
  contradicts: boolean;
  /** Free-form explanation, folded into the `memory.superseded` reason. */
  reason?: string;
}

/** A judge decides ONLY contradicts/doesn't — see module doc for why winner
 *  selection is deliberately kept out of this seam. */
export type Judge = (pair: JudgePair) => Promise<JudgeVerdict>;

function buildJudgePrompt(pair: JudgePair): string {
  return [
    "Two decision memories from an engineering project's memory store follow.",
    "Judge whether they GENUINELY CONTRADICT each other (one invalidates or",
    "reverses the other) as opposed to merely being similar, complementary, or",
    "about related-but-distinct topics.",
    "",
    `Memory A: ${pair.a.text}`,
    `Memory B: ${pair.b.text}`,
    "",
    'Respond with ONLY a JSON object of the shape {"contradicts": boolean, "reason": string}.',
  ].join("\n");
}

function parseJudgeResponse(raw: string): JudgeVerdict {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw) as {
      contradicts?: unknown;
      reason?: unknown;
    };
    return {
      contradicts: parsed.contradicts === true,
      ...(typeof parsed.reason === "string" && parsed.reason ? { reason: parsed.reason } : {}),
    };
  } catch {
    return { contradicts: false };
  }
}

/**
 * LLM-backed `Judge`. Talks ONLY to the injected `ConsolidatorLlm.complete()`
 * — no endpoint/apiKey/model resolution lives here, matching the
 * `ConsolidatorLlm` seam everywhere else in the kernel (the harness resolves
 * that config and injects the client; the kernel never reads env or calls
 * `fetch` itself). `llm` absent degrades to "never contradicts", the same
 * off-by-default convention as the `Embedder` seam — a missing LLM must never
 * throw or block a consolidation boundary.
 */
export function makeLlmJudge(llm?: ConsolidatorLlm): Judge {
  return async (pair: JudgePair): Promise<JudgeVerdict> => {
    if (!llm) return { contradicts: false };
    try {
      const raw = await llm.complete(buildJudgePrompt(pair));
      return parseJudgeResponse(raw);
    } catch {
      return { contradicts: false };
    }
  };
}

export interface DetectedContradiction {
  winnerId: string;
  loserId: string;
  reason: string;
  conflict: Conflict;
}

export interface DetectContradictionsParams {
  projectId: string;
  /** Optional — absent means no embeddings exist yet, so this is a no-op
   *  (mirrors ensureEmbeddings/semanticSearch: embeddings off = silent
   *  skip, never an error). */
  embedder?: Embedder;
  judge: Judge;
  actor: string;
  cosineThreshold?: number;
}

/** Deterministic (createdAt, id) winner — same convergence rule documented on
 *  `Conflict.concurrent`. Independent of judge/LLM output so every replica
 *  reaches the same outcome from the same pair of memories. */
function pickWinner(a: MemoryRecord, b: MemoryRecord): [MemoryRecord, MemoryRecord] {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt > b.createdAt ? [a, b] : [b, a];
  }
  return a.id > b.id ? [a, b] : [b, a];
}

/**
 * Scan every valid `decision`-kind memory for pairwise semantic
 * contradictions and resolve each confirmed one (supersede the loser, raise a
 * Conflict). Returns the contradictions actually applied, in detection order.
 *
 * Deliberately a single boundary pass over a snapshot of the valid set taken
 * at call time (mirrors ensureEmbeddings' stale-batch model) — a memory that
 * loses one pairwise judgement is not re-excluded from later pairs in the
 * same call, so a memory transitively contradicted by two others can end up
 * `supersededBy` only the first; that's an accepted limitation of a
 * from-scratch pass, not a partial-application bug (a later call re-scans the
 * post-supersede valid set and only compares still-valid memories).
 */
export async function detectContradictions(
  params: DetectContradictionsParams,
): Promise<DetectedContradiction[]> {
  const { projectId, embedder, judge, actor } = params;
  if (!embedder) return [];

  const decisions = listValidMemories(projectId)
    .map((row) => row.memory)
    .filter((memory) => memory.kind === "decision");
  if (decisions.length < 2) return [];

  const vectorById = new Map(
    listEmbeddings(projectId, "memory").map((row) => [row.entityId, row.vector]),
  );
  const threshold = params.cosineThreshold ?? DEFAULT_COSINE_THRESHOLD;

  const alreadyResolved = new Set<string>();
  const results: DetectedContradiction[] = [];

  for (let i = 0; i < decisions.length; i += 1) {
    const a = decisions[i]!;
    if (alreadyResolved.has(a.id)) continue;
    const vecA = vectorById.get(a.id);
    if (!vecA) continue;

    for (let j = i + 1; j < decisions.length; j += 1) {
      const b = decisions[j]!;
      if (alreadyResolved.has(b.id)) continue;
      const vecB = vectorById.get(b.id);
      if (!vecB) continue;
      if (cosineSimilarity(vecA, vecB) < threshold) continue;

      const verdict = await judge({
        a: { id: a.id, text: a.text },
        b: { id: b.id, text: b.text },
      });
      if (!verdict.contradicts) continue;

      const [winner, loser] = pickWinner(a, b);
      const reason = `${SEMANTIC_CONTRADICTION_REASON_PREFIX}${
        verdict.reason ?? "embedding cosine prefilter + LLM judge flagged a semantic contradiction"
      }`;

      await appendEvent({
        type: "memory.superseded",
        projectId,
        scopeType: "project",
        scopeId: projectId,
        actor,
        payload: { supersedes: loser.id, supersededBy: winner.id, reason },
      });

      const conflict = createConflict({
        projectId,
        scopeType: "decision",
        scopeId: winner.id,
        fieldPath: "memory.text",
        leftVersion: a.id,
        rightVersion: b.id,
        conflictType: "decision",
      });
      // scopeId = the conflict's OWN id (see conflict-service.ts comment):
      // `state.conflicts` is keyed by `event.scopeId` in the projector, so a
      // second conflict in the same boundary pass must not collide with the
      // first.
      await appendEvent({
        type: "conflict.detected",
        projectId,
        scopeType: "project",
        scopeId: conflict.id,
        actor,
        payload: conflict,
      });

      alreadyResolved.add(loser.id);
      results.push({ winnerId: winner.id, loserId: loser.id, reason, conflict });
      break;
    }
  }

  if (results.length > 0) {
    await rebuildProjectProjection(projectId);
  }
  return results;
}

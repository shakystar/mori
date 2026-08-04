import type { ConsolidatorLlm } from "../index.js";
import type { Embedder } from "../index.js";
import { createConflict, type Conflict, type MemorySupersededPayload } from "../domain/entities.js";
import type { DomainEvent } from "../domain/events.js";
import type { MemoryRecord } from "../projections/projector.js";
import { cosineSimilarity } from "./embeddings-service.js";
import { listEmbeddings } from "./embeddings-store.js";
import { listValidMemories, rebuildProjectProjection } from "./projection-store.js";
import { appendEvents, isStaleHeadError, readHeadEventId } from "../storage/event-store.js";

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
 * at call time (mirrors ensureEmbeddings' stale-batch model): `decisions` and
 * `vectorById` are read once up front, so a memory superseded earlier in this
 * same pass still occupies its snapshot slot — but the `alreadyResolved` set
 * (populated as each pair resolves) excludes it from every later comparison,
 * both as a further `a` and as a future `b`, so no already-lost memory is
 * ever re-judged in the same call. A memory that survives as winner keeps
 * scanning the rest of the snapshot in the same pass, so if it contradicts
 * two different memories, both are applied here; only a memory that itself
 * loses stops being scanned further (a later call re-scans the post-supersede
 * valid set and only compares still-valid memories).
 *
 * #253: every append is a compare-and-append against the head this snapshot
 * was taken at. A refusal means another writer moved the log while a judge was
 * deciding, so the pass STOPS there and returns what it had already applied —
 * see the catch site for why stopping beats retrying or throwing.
 */
export async function detectContradictions(
  params: DetectContradictionsParams,
): Promise<DetectedContradiction[]> {
  const { projectId, embedder, judge, actor } = params;
  if (!embedder) return [];

  // #253 (#189 A): the head as of the instant this pass's judgment basis was
  // taken. Read BEFORE the snapshot below, never after — see
  // `AppendEventsOptions.expectedHead` for why that order is the safe one.
  // Every append in the loop carries it, so a verdict computed from this
  // snapshot can no longer land on a log that moved while the judge was
  // thinking (`project-lock.ts` classifies this whole call as UNSAFE tail
  // work: it runs past the boundary's last dispossession check point, and one
  // judge LLM round trip per compared pair is how long the window stays open).
  let expectedHead = (await readHeadEventId(projectId)) ?? null;

  const decisions = listValidMemories(projectId)
    .map((row) => row.memory)
    .filter((memory) => memory.kind === "decision");
  if (decisions.length < 2) return [];

  // Filtered to the active embedder's model (mirrors semanticScoresForKind /
  // search-service.ts) so a mid-flight `MEMORIZE_EMBEDDINGS_MODEL` change never
  // mixes vectors from two coordinate spaces into one cosine comparison.
  // Unlike search-service.ts (which has queryVec-only callers with no
  // embedder to name a model), this function returns early above when
  // `embedder` is absent, so there is no no-model case to fall back on here.
  const vectorById = new Map(
    listEmbeddings(projectId, "memory", embedder.model).map((row) => [row.entityId, row.vector]),
  );
  const threshold = params.cosineThreshold ?? DEFAULT_COSINE_THRESHOLD;

  const alreadyResolved = new Set<string>();
  const results: DetectedContradiction[] = [];
  // Set when an append is refused for a stale head: the snapshot every
  // remaining pair would be judged against is now KNOWN stale, so the pass
  // stops rather than spending more judge round trips on it. See the catch
  // below for why giving up (rather than retrying or throwing) is the right
  // recovery here.
  let staleBasis = false;

  for (let i = 0; i < decisions.length && !staleBasis; i += 1) {
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

      const conflict = createConflict({
        projectId,
        scopeType: "decision",
        scopeId: winner.id,
        fieldPath: "memory.text",
        leftVersion: a.id,
        rightVersion: b.id,
        conflictType: "decision",
      });

      // One confirmed contradiction is logically a single operation — both
      // events go through appendEvents (one db.transaction) so a failure on
      // the second insert can never leave the loser durably superseded
      // without the conflict that explains why (#118 item 3).
      //
      // #253: `expectedHead` makes that same transaction refuse the pair when
      // the log moved while the judge was deciding. Without it the loser of a
      // two-process race writes a permanent, non-idempotent verdict
      // (`createConflict` mints a fresh random id, so the winner's and the
      // loser's both survive) computed from memories that may already have
      // been superseded out from under it.
      let appended: DomainEvent<MemorySupersededPayload | Conflict>[];
      try {
        appended = await appendEvents<MemorySupersededPayload | Conflict>(
          projectId,
          [
            {
              type: "memory.superseded",
              projectId,
              scopeType: "project",
              scopeId: projectId,
              actor,
              payload: { supersedes: loser.id, supersededBy: winner.id, reason },
            },
            // scopeId = the conflict's OWN id (see conflict-service.ts comment):
            // `state.conflicts` is keyed by `event.scopeId` in the projector, so a
            // second conflict in the same boundary pass must not collide with the
            // first.
            {
              type: "conflict.detected",
              projectId,
              scopeType: "project",
              scopeId: conflict.id,
              actor,
              payload: conflict,
            },
          ],
          { expectedHead },
        );
      } catch (error) {
        if (!isStaleHeadError(error)) throw error;
        // GIVE UP the rest of the pass; do NOT rethrow. This function is tail
        // work for both its callers (a consolidation boundary and an import),
        // and both run it BEFORE committing their cursors — throwing from here
        // would leave a boundary's window unconsumed and hand the next boundary
        // the same observations to distill a second time, buying a rare race
        // with a certain duplicate. Retrying is not the answer either: the
        // whole batch of verdicts came from a snapshot that is now known stale,
        // so honest recovery means re-judging from a fresh one, and that is a
        // fresh LLM round trip per pair. Contradiction detection is a repeated
        // best-effort sweep — the next boundary or import runs it again over
        // current data. What must not happen (and now cannot) is this pass's
        // stale verdict landing anyway.
        staleBasis = true;
        break;
      }
      // Our own append IS the head now. The basis snapshot is deliberately
      // kept (see this function's doc), so the next pair is still certified
      // against everything EXCEPT what this pass itself just wrote.
      expectedHead = appended.at(-1)?.id ?? expectedHead;

      alreadyResolved.add(loser.id);
      results.push({ winnerId: winner.id, loserId: loser.id, reason, conflict });
      // Only stop scanning `a` when `a` itself lost — a surviving winner
      // must keep comparing against the rest of the snapshot in this same
      // pass, or a second contradiction in one call would be missed (#118
      // item 4).
      if (loser.id === a.id) break;
    }
  }

  if (results.length > 0) {
    await rebuildProjectProjection(projectId);
  }
  return results;
}

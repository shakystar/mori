/**
 * The ONE ceiling on injected memory, and the one place it is enforced (#238).
 *
 * Before this module there was no combined ceiling at all. Two independent char
 * budgets (`MEMORY_POOL_BUDGET_CHARS`, `SEGMENT_POOL_BUDGET_CHARS`) each trimmed
 * their own channel at retrieval time, their sum was the effective limit by
 * accident rather than by declaration, and the layer their docs pointed at
 * (`MAX_STARTUP_CONTEXT_CHARS`) did not exist. Nothing downstream re-checked:
 * `context-render.ts` states as its own discipline that it never re-budgets, and
 * the harness seam only wraps the rendered text in a message.
 *
 * Two things follow from where the enforcement had to go:
 *
 * 1. **It is measured on the RENDERED block, not on raw text.** The retrieval
 *    budgets count stored characters plus a `+24` per-item guess (segments not
 *    even that); the injected string also carries the header, the section
 *    titles, the real `- [kind · salience N · date] ` prefixes and the segment
 *    fences. Budgeting the input to a render and calling it a budget on the
 *    output is how "a 6000-char budget" became a number nobody could tie to
 *    what was actually sent.
 * 2. **It runs here, in assembly, not inside the renderer.** Trimming needs the
 *    ranking (`RankedPoolEntry`), and `MemoryContext` — the renderer's whole
 *    input — deliberately does not carry scores. Doing it here keeps
 *    `context-render.ts`'s "the pool arrives already trimmed" discipline TRUE
 *    rather than making it a second budgeting site, and it is the last stage
 *    that sees the pool, so no caller can route around it: the only
 *    `MemoryContext` the kernel ever hands a harness comes out of this
 *    function.
 *
 * The renderer is called (repeatedly, on the over-budget path) as the measuring
 * instrument. That is deliberate: the check must be against the exact string
 * `renderMemoryContext` produces, so any future change to the framing — a
 * longer header, a new per-item field — is accounted for automatically instead
 * of silently pushing the real injection past the stated ceiling.
 */

import type { Observation } from "../domain/entities.js";
import { isEmptyMemoryContext, renderMemoryContext } from "./context-render.js";
import type { MemoryContext } from "./context-service.js";
import {
  MEMORY_POOL_BUDGET_CHARS,
  SEGMENT_POOL_BUDGET_CHARS,
  type RankedPoolEntry,
  type RetrievedSegment,
} from "./memory-retrieval-service.js";
import { estimateTokens } from "./token-estimate.js";

/**
 * The canonical injection ceiling, in tokens (roadmap #5's wording: "주입
 * 예산(토큰 상한)").
 *
 * DERIVED, not hand-picked: it is exactly today's effective ceiling — the sum
 * of the two retrieval-stage char budgets — put through the repo's existing
 * conservative conversion. #238 is a structural fix, so the number it starts
 * with must be one that changes nothing about how much memory a healthy
 * session gets; re-tuning it is a separate decision, to be made against the
 * measurements this issue records rather than in advance.
 *
 * Deriving it also means the two retrieval pre-trims and this ceiling cannot
 * drift apart: raising a channel budget without thinking about the total is no
 * longer possible, because the total is that sum.
 */
export const INJECTION_BUDGET_TOKENS = estimateTokens(
  MEMORY_POOL_BUDGET_CHARS + SEGMENT_POOL_BUDGET_CHARS,
);

/** Estimated tokens of the block a context would actually inject. */
function injectedTokens(context: MemoryContext): number {
  return estimateTokens(renderMemoryContext(context).length);
}

function assemble(ranked: RankedPoolEntry[], segments: RetrievedSegment[]): MemoryContext {
  const memories = ranked.flatMap((entry) => (entry.channel === "memory" ? [entry.memory] : []));
  const observations: Observation[] = ranked.flatMap((entry) =>
    entry.channel === "observation" ? [entry.observation] : [],
  );
  return {
    ...(segments.length > 0 ? { rawSegments: segments } : {}),
    ...(memories.length > 0
      ? {
          consolidatedMemories: memories.map(({ memory }) => ({
            id: memory.id,
            kind: memory.kind,
            text: memory.text,
            salience: memory.salience,
            createdAt: memory.createdAt,
          })),
        }
      : {}),
    ...(observations.length > 0
      ? {
          recentObservations: observations.map((observation) => ({
            signal: observation.signal,
            ...(observation.toolName ? { toolName: observation.toolName } : {}),
            ...(observation.summary ? { summary: observation.summary } : {}),
            createdAt: observation.createdAt,
          })),
        }
      : {}),
  };
}

/**
 * Assemble the retrieved channels into the context to inject, dropping the
 * least valuable entries until the RENDERED block fits
 * {@link INJECTION_BUDGET_TOKENS}.
 *
 * Drop order — lowest value first, which is the order today's code already
 * declares its intent in ("segments can never evict consolidated memories"):
 *
 * 1. **Segments**, worst-ranked first. A segment is verbatim transcript that
 *    consolidation has usually already distilled into a memory, so it is the
 *    one channel whose loss is most often redundant rather than absolute.
 * 2. **The memory/observation pool**, lowest score first. The two are ranked in
 *    ONE pool by score, so score — not channel — is what decides: an
 *    observation the ranking put above a memory outlives it.
 *
 * Deterministic by construction: the same retrieval produces the same `ranked`
 * order and the same segment order, and this drops from the end of each.
 *
 * One entry per iteration, re-rendering each time, because the entries are not
 * independent — dropping the last memory removes the whole `## Consolidated
 * memory` heading, and a segment's fence width depends on the segment. Only the
 * over-budget path pays for it, and it pays one render per dropped entry.
 */
export function fitInjectionBudget(input: {
  ranked: RankedPoolEntry[];
  segments: RetrievedSegment[];
}): MemoryContext {
  let ranked = input.ranked;
  let segments = input.segments;

  for (;;) {
    const context = assemble(ranked, segments);
    // Empty is trivially within budget (it renders to ""), and is also the
    // terminating case: every iteration drops exactly one entry, so a corpus
    // that somehow cannot fit ends up here rather than looping.
    if (isEmptyMemoryContext(context)) return context;
    if (injectedTokens(context) <= INJECTION_BUDGET_TOKENS) return context;
    if (segments.length > 0) segments = segments.slice(0, -1);
    else ranked = ranked.slice(0, -1);
  }
}

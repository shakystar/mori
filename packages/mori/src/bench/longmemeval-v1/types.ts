/**
 * Types for LongMemEval(v1) `longmemeval-cleaned` (MIT, ICLR 2025,
 * https://github.com/xiaowu0162/LongMemEval / https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)
 * — #507's dataset-loader slice (#344 조각 2/4). Field names mirror the on-disk
 * `longmemeval_s_cleaned.json` schema documented in the upstream repo README's "Dataset Format"
 * section, translated from snake_case to camelCase. Unlike LongMemEval-V2 (see
 * `../longmemeval-v2/types.ts`), v1's "session" really is a conversational session — a list of
 * `{role, content}` turns — so this loader's types line up directly with mori's own turn model;
 * see `docs/bench/longmemeval-v1-feasibility-2026-08-30.md` §4 for the mapping decision (this
 * slice documents the mapping, it does not implement ingestion).
 */

export type LongMemEvalRole = "user" | "assistant";

/**
 * The benchmark's five core long-term memory abilities (arXiv 2410.10813 §1: "information
 * extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention").
 * Distinct from the raw `question_type` field on disk, which has 6 values plus a cross-cutting
 * abstention flag — see `abilityForQuestion` for how the two combine.
 */
export const MEMORY_ABILITIES = {
  informationExtraction: "information-extraction",
  multiSessionReasoning: "multi-session-reasoning",
  knowledgeUpdates: "knowledge-updates",
  temporalReasoning: "temporal-reasoning",
  abstention: "abstention",
} as const;

export type MemoryAbility = (typeof MEMORY_ABILITIES)[keyof typeof MEMORY_ABILITIES];

/**
 * Maps the raw `question_type` field (6 values, confirmed against the real
 * `longmemeval_s_cleaned.json`: `single-session-user` 70, `single-session-assistant` 56,
 * `single-session-preference` 30, `multi-session` 133, `knowledge-update` 78,
 * `temporal-reasoning` 133 — sums to 500) to 4 of the 5 documented abilities. The 5th
 * (abstention) is NOT one of these 6 values — per the official `print_qa_metrics.py`
 * (`src/evaluation/print_qa_metrics.py` in the code repo), abstention questions keep their base
 * `question_type` and are identified separately by `question_id` ending in `_abs` (confirmed:
 * 30/500 questions in the real file have an `_abs`-suffixed id, drawn from exactly 4 of the 6
 * base types — none from `single-session-assistant` or `single-session-preference`). See
 * `abilityForQuestion`, which layers that `_abs` check on top of this table.
 *
 * `single-session-preference`'s mapping to `informationExtraction` is this slice's own judgment
 * call, not a mapping the paper states explicitly. Paper text (arXiv 2410.10813, "seven question
 * types" paragraph): "Single-session-user and single-session-assistant test memorizing the
 * information mentioned by user or assistant within a single session. Single-session-preference
 * tests whether the model can utilize the user information to generate a personalized response."
 * — grouped with the other two single-session types by construction methodology and the paper
 * never gives it a distinct ability bucket among the 5, so this slice folds it into information
 * extraction. Confirm against the paper before relying on this for per-ability scoring — see the
 * feasibility doc's judgment-call section.
 */
export const QUESTION_TYPE_TO_ABILITY: Readonly<Record<string, MemoryAbility>> = {
  "single-session-user": MEMORY_ABILITIES.informationExtraction,
  "single-session-assistant": MEMORY_ABILITIES.informationExtraction,
  "single-session-preference": MEMORY_ABILITIES.informationExtraction,
  "multi-session": MEMORY_ABILITIES.multiSessionReasoning,
  "knowledge-update": MEMORY_ABILITIES.knowledgeUpdates,
  "temporal-reasoning": MEMORY_ABILITIES.temporalReasoning,
};

/** Fails loudly on an unrecognized `question_type` rather than silently dropping the question
 * from ability-based reporting. Abstention overrides the base type's ability — a question whose
 * `id` ends in `_abs` is scored on abstention regardless of which of the 6 base types it was
 * drawn from (see `QUESTION_TYPE_TO_ABILITY`'s doc comment). */
export function abilityForQuestion(questionType: string, id: string): MemoryAbility {
  const ability = QUESTION_TYPE_TO_ABILITY[questionType];
  if (ability === undefined) {
    throw new Error(
      `longmemeval-v1: 알 수 없는 question_type "${questionType}" — QUESTION_TYPE_TO_ABILITY(types.ts)에 매핑을 추가해라.`,
    );
  }
  if (id.endsWith("_abs")) return MEMORY_ABILITIES.abstention;
  return ability;
}

export interface LongMemEvalTurn {
  role: LongMemEvalRole;
  content: string;
  /** Present (`true`/`false`) only within a haystack session that was built as evidence for
   * some question's answer, where every turn in that session is labeled — `true` on the turn(s)
   * that actually carry the answer, `false` on the rest of that same session. `undefined` on
   * every turn in a filler session (confirmed against the real `longmemeval_s_cleaned.json`:
   * the field appears on 10,960/246,750 turns dataset-wide, split 896 `true` / 10,064 `false`;
   * it is never partially present within one session — a session either labels all of its turns
   * or none). Field presence alone does not mean "this is the evidence turn" — check the value,
   * not just `hasAnswer !== undefined`. */
  hasAnswer?: boolean;
}

export interface LongMemEvalHaystackSession {
  /** Raw `haystack_session_ids[i]`. **Not guaranteed unique within one question's haystack** —
   * the real `longmemeval_s_cleaned.json` replays the same filler session id at a different
   * position/date in 13/500 questions (same `sessionId`, same turn content, different `date`).
   * Identify a session within a haystack by `(sessionId, index)`, never by `sessionId` alone. */
  sessionId: string;
  /** Raw `haystack_dates[i]`, upstream free-text format `"YYYY/MM/DD (Ddd) HH:MM"` (e.g.
   * `"2023/05/20 (Sat) 02:21"`) — not ISO 8601. Kept verbatim; no parsing done here. */
  date: string;
  turns: readonly LongMemEvalTurn[];
}

export interface LongMemEvalQuestion {
  id: string;
  /** Raw on-disk category (one of the 6 `QUESTION_TYPE_TO_ABILITY` keys). Kept alongside
   * `ability` so a caller can distinguish e.g. `single-session-user` from
   * `single-session-assistant` without re-deriving them, even though both map to the same
   * ability. */
  questionType: string;
  ability: MemoryAbility;
  /** `true` iff `id` ends in `_abs` — see `abilityForQuestion`. Redundant with
   * `ability === MEMORY_ABILITIES.abstention` but named explicitly since abstention questions
   * still carry a real (non-abstention) `questionType`. */
  isAbstention: boolean;
  question: string;
  /** Raw `question_date`, same free-text format as `LongMemEvalHaystackSession.date`. */
  questionDate: string;
  answer: string;
  /** Subset of this question's `haystackSessions[].sessionId` values that hold the evidence for
   * `answer` — confirmed against the real file that every id here also appears in
   * `haystackSessions` (0 mismatches across all 500 questions). */
  answerSessionIds: readonly string[];
  /** Ordered exactly as `haystack_session_ids`/`haystack_dates`/`haystack_sessions` appear on
   * disk (index-aligned across the three arrays) — this array's ordering is what "session
   * boundary" means for v1: one entry per haystack position, not deduplicated by `sessionId`
   * (see `LongMemEvalHaystackSession.sessionId`'s doc comment). */
  haystackSessions: readonly LongMemEvalHaystackSession[];
}

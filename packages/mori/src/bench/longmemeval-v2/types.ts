/**
 * Types for LongMemEval-V2 (arXiv 2605.12493, Apache-2.0,
 * https://github.com/xiaowu0162/LongMemEval-V2 / https://huggingface.co/datasets/xiaowu0162/longmemeval-v2)
 * — #490's feasibility slice (#344 조각 1/N). Field names mirror the released `SCHEMA.md`
 * (`questions.jsonl` / `trajectories.jsonl`), translated from snake_case to camelCase; nothing
 * here reshapes the data into mori's own session/turn model. LME-V2 trajectories are web-agent
 * action/state traces (accessibility trees, screenshots, browser actions) rather than
 * conversational turns, so that reshaping is a real design decision left to the ingestion slice
 * (see `docs/bench/longmemeval-v2-feasibility-2026-08-29.md` §1 for why this loader does not
 * attempt it).
 */

export type LongMemEvalDomain = "web" | "enterprise";

/**
 * The benchmark's five memory abilities (README "core memory abilities" list). Distinct from
 * the raw `question_type` field on disk, which has seven values — see
 * `QUESTION_TYPE_TO_ABILITY` for the mapping and its evidence.
 */
export const MEMORY_ABILITIES = {
  staticStateRecall: "static-state-recall",
  dynamicStateTracking: "dynamic-state-tracking",
  workflowKnowledge: "workflow-knowledge",
  environmentGotchas: "environment-gotchas",
  premiseAwareness: "premise-awareness",
} as const;

export type MemoryAbility = (typeof MEMORY_ABILITIES)[keyof typeof MEMORY_ABILITIES];

/**
 * Maps the raw `question_type` field (7 values observed in the released `questions.jsonl`) to
 * one of the 5 documented memory abilities. The `-abs` suffix is not defined field-by-field in
 * the paper or `SCHEMA.md` — this mapping is this slice's own inference from arXiv 2605.12493
 * §3.2 ("based on existing static, dynamic, and workflow questions, we curate abstention
 * questions with wrong premises") plus `DATA_CARD.md`'s "premise-awareness/abstention
 * categories" phrasing: each `-abs` variant is an abstention question built from its base
 * category, so it scores premise awareness rather than the base ability. Confirm against the
 * paper before relying on this for scoring — see the feasibility doc's judgment-call section.
 */
export const QUESTION_TYPE_TO_ABILITY: Readonly<Record<string, MemoryAbility>> = {
  "static-environment": MEMORY_ABILITIES.staticStateRecall,
  "static-environment-abs": MEMORY_ABILITIES.premiseAwareness,
  "dynamic-environment": MEMORY_ABILITIES.dynamicStateTracking,
  "dynamic-environment-abs": MEMORY_ABILITIES.premiseAwareness,
  procedure: MEMORY_ABILITIES.workflowKnowledge,
  "procedure-abs": MEMORY_ABILITIES.premiseAwareness,
  "errors-gotchas": MEMORY_ABILITIES.environmentGotchas,
};

/** Fails loudly on an unrecognized `question_type` rather than silently dropping the question
 * from ability-based reporting. */
export function abilityForQuestionType(questionType: string): MemoryAbility {
  const ability = QUESTION_TYPE_TO_ABILITY[questionType];
  if (ability === undefined) {
    throw new Error(
      `longmemeval-v2: 알 수 없는 question_type "${questionType}" — QUESTION_TYPE_TO_ABILITY(types.ts)에 매핑을 추가해라.`,
    );
  }
  return ability;
}

export interface LongMemEvalQuestion {
  id: string;
  domain: LongMemEvalDomain;
  environment: string;
  /** Raw on-disk category (e.g. `"static-environment-abs"`). Kept alongside `ability` so a
   * caller can distinguish abstention variants without re-deriving them. */
  questionType: string;
  ability: MemoryAbility;
  question: string;
  /** Path under `question_screenshots/`, resolved relative to the data dir; `null` for
   * text-only questions. */
  image: string | null;
  answer: string;
  evalFunction: string;
}

export interface LongMemEvalTrajectoryState {
  stateIndex: number;
  step: number | null;
  url: string;
  /** `null` for the initial state. */
  action: string | null;
  thought: string | null;
  accessibilityTree: string;
  /** Path under `screenshots/<trajectory_id>/<step>.png`, resolved relative to the data dir. */
  screenshot: string;
}

export interface LongMemEvalTrajectory {
  id: string;
  domain: LongMemEvalDomain;
  environment: string;
  goal: string;
  outcome: "success" | "failure";
  startUrl: string;
  /** Ordered by `stateIndex` — this is the "session boundary" a trajectory represents: one
   * continuous agent run through an environment, from its first state to its last. */
  states: readonly LongMemEvalTrajectoryState[];
}

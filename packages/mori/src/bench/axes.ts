/**
 * Shared axis-name constants for `CostLedger.record(axis, usage)` (cost-ledger.ts, #373).
 * `record`'s `axis` parameter stays a free string on purpose (#373's "no hardcoded enum"
 * completion condition) — this file is the *caller-side* discipline instead: every call site
 * under `bench/` references `BENCH_AXES.*` rather than a literal, so a typo'd axis name
 * (`"injection-hit-rate"` vs `"injection_hit_rate"`) fails to compile instead of silently
 * splitting a dashboard metric into two axes (owner review, PR #377 cross-reference,
 * cost-ledger.ts:15). Adding a new axis (e.g. #242's retrieval-quality axis) is one line here.
 */
export const BENCH_AXES = {
  injectionHitRate: "injection-hit-rate",
  reDistillationRate: "re-distillation-rate",
  reQuestionRate: "re-question-rate",
  cost: "cost",
} as const;

export type BenchAxis = (typeof BENCH_AXES)[keyof typeof BENCH_AXES];

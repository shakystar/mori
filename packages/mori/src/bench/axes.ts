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
  /**
   * #449: `MoriSession.close()`'s own session-end consolidation call — kept OUT of `cost`
   * on purpose. That axis is context turns + compaction + the follow-up turn (see
   * `preference-regression/runner.ts`'s three `record(BENCH_AXES.cost, ...)` call sites);
   * folding session-end distillation into the same bucket would make "how much does mori's
   * own distillation cost" unreadable again, which is the exact gap PR #448 §5-a found.
   */
  sessionEndDistillation: "session-end-distillation",
} as const;

export type BenchAxis = (typeof BENCH_AXES)[keyof typeof BENCH_AXES];

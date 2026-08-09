/**
 * Injection yield — the vocabulary for reading injection telemetry, and the one
 * place the judgement is made (#415, #242 조각 2/2).
 *
 * `memory-retrieval-service.ts` marks every ranking constant a TUNING PARAMETER
 * and says to adjust it against real transcripts. The telemetry that would
 * support that has been accumulating for a while — `memory_access`
 * (`injection_count` / `last_accessed_at`) on the projection side, `memory.injected`
 * on the event side — but nothing read it, because there was no definition of
 * what "this injection was worth it" MEANS. This module is that definition.
 *
 * Three states, and keeping them three is the point:
 *
 * - `reinjected`     — injected on ≥2 distinct occasions.
 * - `injected-once`  — injected on exactly 1 occasion.
 * - `never-injected` — retrieval never put it in front of the model at all.
 *   This is the population `RECENCY_HALF_LIFE_DAYS` decays from `createdAt`,
 *   because a memory with no injection has no reinforcement stamp to decay from.
 *
 * Collapsing the last two into one "waste" bucket is the mistake this module
 * exists to prevent: "the ranking never lifted it" and "the ranking lifted it
 * and nothing came of it" point tuning in OPPOSITE directions (raise the budget
 * vs. fix the ranking), and a two-way split hides which one you are looking at.
 *
 * Alongside the three states, the report carries the axis of what never got in
 * at all: `budgetPressure`, the truncation facts #414 put on the same
 * `memory.injected` event. Three states about what WAS injected cannot say
 * whether to raise the budget or fix the ranking; the drop list is the half
 * that can.
 *
 * The names are deliberately the OBSERVABLE, not the interpretation — there is
 * no `hit`/`miss` here. The proxy these names stand in for, the reason it is
 * the best available signal, and the places it is wrong are in
 * `docs/injection-yield-vocabulary.md`. Read that before treating any number
 * out of here as an accuracy.
 *
 * NOT on the capture path (#242 constraint): this reads the event log and the
 * projection after the fact. `observe()` never calls it — see the acceptance
 * grep in the PR that introduced this file.
 */

import { nowIso } from "../domain/common.js";
import type { InjectionBudgetDrop } from "../domain/entities.js";
import type { MemoryInjectedPayload } from "../domain/entities/memory.js";
import type { DomainEvent } from "../domain/events.js";
import { laneOf, SELF_LANE } from "../projections/projector.js";
import { readEvents } from "../storage/event-store.js";
import { isUnionLog } from "./consolidate-service.js";
import {
  OBSERVATION_TAIL_LIMIT,
  OBSERVATION_TAIL_MAX_AGE_HOURS,
  RECENCY_HALF_LIFE_DAYS,
} from "./memory-retrieval-service.js";
import { listRecentObservations, listValidMemories } from "./projection-store.js";

/**
 * The three-way judgement. Exported as a type (not compared as bare strings at
 * call sites) so adding a fourth state is a compiler error everywhere rather
 * than a silently-unhandled branch.
 */
export type InjectionYield = "reinjected" | "injected-once" | "never-injected";

export const INJECTION_YIELDS: readonly InjectionYield[] = [
  "reinjected",
  "injected-once",
  "never-injected",
];

/**
 * The ONE place the boundary between the three states is drawn.
 *
 * Takes a count of OCCASIONS, not of events: `memory.injected` is appended once
 * per injecting turn and re-sends everything the block still carries, so
 * counting events would score a long session as heavy reuse. An occasion is one
 * session that injected this memory — the same grain reinforcement uses
 * (`firstShown` in `SqliteMemoryKernel.transformContext`), which is what makes
 * this number comparable to `injection_count`.
 */
export function classifyInjectionYield(occasions: number): InjectionYield {
  if (occasions <= 0) return "never-injected";
  if (occasions === 1) return "injected-once";
  return "reinjected";
}

/**
 * The truncation axis (#414, #242 조각 1/2) — what the injection budget pushed
 * OUT, standing in the same report as the three-way judgement above.
 *
 * The two axes only answer #242's question together. "Raise the budget or fix
 * the ranking?" is undecidable from either half alone: a store full of
 * `injected-once` says the ranking lifts the wrong things, but if those turns
 * were also cutting `memory`-channel entries to fit, the ranking never got to
 * show what it would have chosen. Read them as one row, not two reports.
 */
export interface BudgetPressure {
  /** Injecting turns that cut at least one entry. */
  turnsWithDrops: number;
  /**
   * Injecting turns in total — the denominator `turnsWithDrops` is a share of.
   * One `memory.injected` event per injecting turn, so this counts turns that
   * actually reached the model, not retrievals.
   */
  totalInjections: number;
  /**
   * Drops per channel. `segment` alone means the documented priority worked
   * (verbatim transcript, usually already distilled, yields first); `memory` or
   * `observation` appearing means the ceiling reached past the cheap channel
   * into what the ranking actually chose.
   */
  dropsByChannel: Record<InjectionBudgetDrop["channel"], number>;
  /**
   * Every `order: 1` entry — the first thing each trimming turn cut, i.e. the
   * cheapest one to buy back. At most one per turn, so this is bounded by
   * {@link turnsWithDrops} and carries no per-turn identity: it is the
   * population "what does the margin of the budget look like", not a timeline.
   */
  firstCut: InjectionBudgetDrop[];
}

/** What one replay of the event log yields — both axes, from the same pass. */
export interface InjectionLogSummary {
  /** memoryId → number of distinct sessions that injected it. */
  occasionsById: Map<string, number>;
  budgetPressure: BudgetPressure;
}

/**
 * Walk `memory.injected` ONCE and take everything the report needs off it.
 *
 * Both axes are carried by the same event by construction (#414 put `dropped`
 * on the `memory.injected` payload rather than minting an event type), so
 * separate readers would mean replaying the log twice for facts that arrive
 * together — and this replay is the expensive part of the whole report.
 *
 * Occasions, not events: `memory.injected` is appended once per injecting turn
 * and re-sends everything the block still carries, so counting events would
 * score a long session as heavy reuse. `scopeId` is the session id (the kernel
 * appends with `scopeType: "session"`), and falls back to the project id when
 * the kernel was constructed without one. That fallback collapses every
 * session-less injection into a single occasion, which UNDER-counts reuse and
 * never over-counts — the direction this whole module is biased in on purpose.
 *
 * SELF LANE ONLY, via the shared `laneOf` — in a workspace union the log also
 * carries other members' `memory.injected` events, and counting those would
 * credit THIS store's ranking with an injection another store's ranking made.
 * The memory population this is joined against (`listValidMemories`) is
 * self-lane by default, so classifying events any other way would put the two
 * halves of every ratio on different populations. The drop tally takes the same
 * filter for the same reason: another member's budget pressure is not this
 * store's evidence about its own ceiling.
 */
export function summarizeInjectionEvents(
  events: readonly DomainEvent[],
  selfProjectId: string,
  isUnion: boolean,
): InjectionLogSummary {
  const sessionsById = new Map<string, Set<string>>();
  const dropsByChannel: Record<InjectionBudgetDrop["channel"], number> = {
    memory: 0,
    observation: 0,
    segment: 0,
  };
  const firstCut: InjectionBudgetDrop[] = [];
  let turnsWithDrops = 0;
  let totalInjections = 0;

  for (const event of events) {
    if (event.type !== "memory.injected") continue;
    if (laneOf(event, selfProjectId, isUnion) !== SELF_LANE) continue;
    totalInjections += 1;

    const { memoryIds, dropped } = (event.payload ?? {}) as Partial<MemoryInjectedPayload>;
    if (Array.isArray(memoryIds)) {
      for (const memoryId of memoryIds) {
        let sessions = sessionsById.get(memoryId);
        if (!sessions) {
          sessions = new Set<string>();
          sessionsById.set(memoryId, sessions);
        }
        sessions.add(event.scopeId);
      }
    }

    // Absent on the ordinary within-budget path — trimming is the exception,
    // and an untrimmed turn still counts in `totalInjections` above.
    if (!Array.isArray(dropped) || dropped.length === 0) continue;
    turnsWithDrops += 1;
    for (const drop of dropped) {
      // `hasOwn`, not `in`: the payload is JSON off the log, and `in` would let
      // a channel named after an Object.prototype key (`constructor`, …) past
      // the guard and then write a NaN own-property onto the tally.
      if (Object.hasOwn(dropsByChannel, drop.channel)) dropsByChannel[drop.channel] += 1;
      if (drop.order === 1) firstCut.push(drop);
    }
  }

  return {
    occasionsById: new Map(
      [...sessionsById].map(([memoryId, sessions]) => [memoryId, sessions.size]),
    ),
    budgetPressure: { turnsWithDrops, totalInjections, dropsByChannel, firstCut },
  };
}

/**
 * Age buckets, in MULTIPLES of `RECENCY_HALF_LIFE_DAYS` rather than in absolute
 * days.
 *
 * That is what makes the buckets evidence FOR tuning that constant instead of
 * evidence that silently re-scales when someone tunes it: "half the reinjected
 * mass sits past two half-lives" stays a statement about the decay curve at
 * whatever value the constant currently holds. This module does not read or
 * propose a value for it (#415 non-scope) — it only reports in its units.
 */
export const AGE_BUCKET_HALF_LIFE_EDGES: readonly number[] = [1, 2, 4];

export type AgeBucketLabel = string;

export interface AgeBucket {
  /** e.g. `"0-1hl"`, `"2-4hl"`, `"4hl+"` — `hl` = one `RECENCY_HALF_LIFE_DAYS`. */
  label: AgeBucketLabel;
  /** Inclusive lower bound in days, so the labels can be tied back to real time. */
  minAgeDays: number;
  /** Exclusive upper bound in days; `null` on the open-ended tail bucket. */
  maxAgeDays: number | null;
}

/** The bucket ladder, oldest bound last. Derived, never hand-written. */
export function ageBuckets(): AgeBucket[] {
  const buckets: AgeBucket[] = [];
  let previous = 0;
  for (const edge of AGE_BUCKET_HALF_LIFE_EDGES) {
    buckets.push({
      label: `${previous}-${edge}hl`,
      minAgeDays: previous * RECENCY_HALF_LIFE_DAYS,
      maxAgeDays: edge * RECENCY_HALF_LIFE_DAYS,
    });
    previous = edge;
  }
  buckets.push({
    label: `${previous}hl+`,
    minAgeDays: previous * RECENCY_HALF_LIFE_DAYS,
    maxAgeDays: null,
  });
  return buckets;
}

function ageBucketLabelFor(ageDays: number): AgeBucketLabel {
  const buckets = ageBuckets();
  for (const bucket of buckets) {
    if (bucket.maxAgeDays === null || ageDays < bucket.maxAgeDays) return bucket.label;
  }
  // Unreachable: the last bucket is open-ended. Kept total for the type.
  return buckets[buckets.length - 1]!.label;
}

export type YieldCounts = Record<InjectionYield, number>;

function emptyCounts(): YieldCounts {
  return { reinjected: 0, "injected-once": 0, "never-injected": 0 };
}

export interface AgeBucketYield extends AgeBucket {
  counts: YieldCounts;
}

export interface LongTermYield {
  /** Valid (non-superseded, non-retracted) memories in the self lane. */
  total: number;
  counts: YieldCounts;
  /** Same population as `counts`, split by age — one entry per {@link ageBuckets} rung. */
  byAge: AgeBucketYield[];
}

/**
 * The short-term layer, which this report can size but CANNOT classify.
 *
 * `memory.injected` carries `memoryIds` and nothing else, and `memory_access`
 * is keyed by memory id, so no observation is attributable to an injection: an
 * observation that rode into the model inside the injected block leaves exactly
 * the same trace as one that was never selected. The count below is therefore
 * the layer's SUPPLY (how many observations retrieval had to choose from),
 * never its yield. Reporting it anyway is deliberate — a report that showed only
 * the long-term layer would read as the whole picture.
 */
export interface ShortTermSupply {
  /**
   * Observations inside the same tail window `retrieveMemoryContext` draws from
   * — the same `sinceIso` AND the same `OBSERVATION_TAIL_LIMIT` cap, so this
   * SATURATES at that limit. A store with 20 and one with 2000 recent
   * observations both report the cap; the number is "did the short-term layer
   * have candidates", not "how many exist".
   */
  eligibleObservations: number;
}

export interface InjectionYieldReport {
  generatedAt: string;
  /** The value the age buckets are denominated in, echoed so a report is self-describing. */
  halfLifeDays: number;
  longTerm: LongTermYield;
  shortTerm: ShortTermSupply;
  /**
   * The truncation axis (#414), in the SAME report as the three-way judgement
   * on purpose — see {@link BudgetPressure} for why the two are undecidable
   * apart. Under-counts in one known direction: a turn the budget emptied
   * completely never appends `memory.injected` at all, so its drops are absent
   * here. That case is written up in the doc's 「아직 세우지 못한 축」.
   */
  budgetPressure: BudgetPressure;
}

/**
 * Compute the yield report for a project from the event log + projection.
 *
 * Two telemetry sources name the same fact and disagree by construction, so the
 * occasion count is the MAX of both rather than either alone:
 *
 * - the event log under-reports, because the `memory.injected` append is
 *   best-effort (`transformContext` swallows its failure so a store that cannot
 *   take the append still injects) and because stores predating mori#214 have
 *   no such events at all;
 * - `memory_access.last_accessed_at` under-reports the COUNT (it is a stamp, not
 *   a history) but is definitive about the existence of at least one injection,
 *   and it survives a projection rebuild for exactly that reason (`db.ts`
 *   carved it out of the rebuild).
 *
 * Neither ever claims an injection that did not happen — both are written only
 * after a render actually succeeded — so taking the max cannot invent reuse.
 * It can still miss it; see the doc.
 *
 * Read-only and lock-free, so a session injecting BETWEEN the event read and
 * the projection read makes the snapshot slightly torn. Bounded and harmless in
 * both directions: an injection that lands after the event read is still caught
 * by the `last_accessed_at` half of the max, and a memory consolidated after it
 * simply reads as `never-injected` — which it is. Taking a lock to tighten this
 * would make a reporting call able to stall the capture path, which is the one
 * thing #242 says this must never do.
 *
 * Async and off the capture path on purpose: it replays the event log.
 */
export async function buildInjectionYieldReport(
  projectId: string,
  opts: { nowIso?: string } = {},
): Promise<InjectionYieldReport> {
  const generatedAt = opts.nowIso ?? nowIso();
  const nowMs = Date.parse(generatedAt);
  // ONE replay, both axes (see `summarizeInjectionEvents`).
  const { occasionsById, budgetPressure } = summarizeInjectionEvents(
    await readEvents(projectId),
    projectId,
    isUnionLog(projectId),
  );

  const counts = emptyCounts();
  const byAge = ageBuckets().map((bucket) => ({ ...bucket, counts: emptyCounts() }));
  const byAgeLabel = new Map(byAge.map((bucket) => [bucket.label, bucket]));

  const rows = listValidMemories(projectId);
  for (const { memory, lastAccessedAt } of rows) {
    const fromEvents = occasionsById.get(memory.id) ?? 0;
    const yieldState = classifyInjectionYield(Math.max(fromEvents, lastAccessedAt ? 1 : 0));
    counts[yieldState] += 1;

    const ageDays = Math.max(0, nowMs - Date.parse(memory.createdAt)) / 86_400_000;
    byAgeLabel.get(ageBucketLabelFor(ageDays))!.counts[yieldState] += 1;
  }

  const sinceIso = new Date(nowMs - OBSERVATION_TAIL_MAX_AGE_HOURS * 3_600_000).toISOString();
  const eligibleObservations = listRecentObservations(projectId, {
    limit: OBSERVATION_TAIL_LIMIT,
    sinceIso,
  }).length;

  return {
    generatedAt,
    halfLifeDays: RECENCY_HALF_LIFE_DAYS,
    longTerm: { total: rows.length, counts, byAge },
    shortTerm: { eligibleObservations },
    budgetPressure,
  };
}

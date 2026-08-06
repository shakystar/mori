import {
  createConsolidatedMemory,
  type ConsolidatedMemory,
  type MemorySupersededPayload,
} from "../domain/entities.js";
import type { ConsolidatorLlm, Embedder } from "../index.js";
import { reduceProjectState, SELF_LANE } from "../projections/projector.js";
import type { MemoryRecord } from "../projections/projector.js";
import {
  appendEvents,
  isStaleHeadError,
  readEvents,
  type AppendEventInput,
} from "../storage/event-store.js";
import {
  ExtractionParseError,
  parseExtractedMemories,
  type ExtractedMemory,
} from "./consolidate-service.js";
import { detectContradictions, makeLlmJudge } from "./contradiction-service.js";
import { ensureEmbeddings } from "./embeddings-service.js";
import { rebuildProjectProjection } from "./projection-store.js";

/**
 * #69/#95 — `memorize memory import`: the ingestion primitive behind
 * agent-driven absorption of pre-existing context (the agent's own harness
 * memory, CLAUDE.local.md / AGENTS.override.md content, user-named doc
 * folders). The AGENT does the reading and distillation — it has the read
 * access and knows its own memory location; this service only ingests the
 * result. The kernel never reads outside the project tree here.
 *
 * Items use the SAME shape and sanitizers as the boundary extractor's output
 * (`parseExtractedMemories`), so lifecycle-evidence fields ride along and
 * malformed evidence degrades to "absent" instead of failing the item.
 *
 * Two things the memorize original did are deliberately absent, matching the
 * #94 consolidate-service port (see that module's doc for the full record):
 *
 * - **No file lock (across processes).** memorize serialized concurrent
 *   imports/boundaries with a per-project lock file guarding detached CLI
 *   subprocesses racing each other. Here this is an in-process call on the
 *   kernel seam, so there is no second PROCESS to serialize against — but
 *   two overlapping in-process calls for the SAME project are a real hazard
 *   (#114): the idempotency guard reads a memory snapshot, and awaiting
 *   `appendEvents` yields the event loop to any other pending call. Two fixes
 *   below close that, without a cross-process file lock:
 *   1. {@link withProjectImportLock} serializes the ENTIRE body per
 *      `projectId` (a same-process promise-chain mutex) — a second call for
 *      the same project simply waits its turn instead of reading a
 *      snapshot the first call is about to invalidate.
 *   2. The dedup snapshot is derived from the event log itself
 *      ({@link readValidMemoriesFromLog}), not from the projection cache, so
 *      a prior call that appended events but died before its own rebuild
 *      (crash between `appendEvents` and `rebuildProjectProjection`) cannot
 *      cause the next call to re-derive a stale "not a duplicate" answer —
 *      the event log, not the projection cache, is the durable idempotency
 *      source.
 *
 *   Cross-process exclusion is a real concern for this repo now — #132 added
 *   `storage/project-lock.ts` and the kernel takes it around capture and
 *   consolidation. Import has no kernel seam yet; when it gets one, its
 *   append + rebuild belongs inside that lock like the others. Neither fix
 *   above substitutes for it, and neither is preempted by it.
 * - **No env/config resolution for the LLM judge.** `llm`/`embedder` are
 *   injected by the caller, same seam discipline as `consolidate()`.
 */

/**
 * Per-project promise-chain mutex. Serializes overlapping `importMemories`
 * calls for the same project so the read-dedup-append sequence of one call
 * can never interleave with another's (see module doc, fix 1). Chained
 * continuations always resolve (never reject) so one call's failure never
 * jams the queue for the next.
 *
 * #137 ①: an entry is dropped once its chain has drained, so a long-lived
 * kernel process that imports into many projects does not accumulate one
 * map entry per project forever. The drop is CONDITIONAL on still being the
 * current tail: an unconditional `delete` would evict an entry a later call
 * has already chained onto, and the call after THAT would find an empty map,
 * start from `Promise.resolve()` and run concurrently with the queue it was
 * supposed to wait behind — silently undoing the serialization above.
 */
const importLocks = new Map<string, Promise<void>>();

async function withProjectImportLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const previous = importLocks.get(projectId) ?? Promise.resolve();
  const turn = previous.then(fn, fn);
  const settled = turn.then(
    () => undefined,
    () => undefined,
  );
  importLocks.set(projectId, settled);
  void settled.then(() => {
    // Still the tail? Then nobody is queued behind us and the slot is dead
    // weight. If a later call has replaced it, leave it alone — that entry is
    // the live queue, not ours.
    if (importLocks.get(projectId) === settled) {
      importLocks.delete(projectId);
    }
  });
  return turn;
}

/**
 * Per-invocation cap. Far above the boundary consolidation noise guard (12):
 * a one-time distillation of weeks of harness memory or an ADR folder
 * legitimately yields dozens of items; anything past this is probably an
 * unreviewed dump.
 *
 * It bounds the number of ITEMS of one call that take effect, not the number
 * of items submitted: an item takes effect by minting a memory OR by retiring
 * one through a folded supersede hint (see {@link MemoryImportResult.droppedSupersedesByCap}).
 * A pure duplicate that carries no hint changes nothing and is free.
 */
export const IMPORT_MAX_ITEMS = 100;

export interface MemoryImportResult {
  imported: number;
  /** Items dropped by the idempotency guard (kind+text already valid). */
  skippedDuplicates: number;
  /**
   * Unique new items (post-dedup) beyond {@link IMPORT_MAX_ITEMS}, dropped by
   * the per-invocation cap. #114: the cap applies AFTER the idempotency guard
   * so pre-existing duplicates earlier in the input can never crowd out real
   * new items — but a genuinely oversized batch still has to drop something,
   * and the caller needs to see that it happened (0 would silently claim
   * nothing was lost). Non-zero means: re-run with the leftover items.
   */
  droppedByCap: number;
  /**
   * `memory.superseded` events written from item-provided `supersedesMemoryId`
   * hints. #137 ②: a hint carried by an item that was FOLDED as a duplicate
   * still invalidates its target, so `{imported: 0, skippedDuplicates: 1}`
   * alone would read as "nothing happened" while an existing memory was in
   * fact retired. Counting every honored hint (duplicate-folded or not) keeps
   * the field's meaning independent of which branch an item took — same
   * reasoning as `droppedByCap`: an effect the caller cannot see is an effect
   * the caller cannot act on.
   */
  honoredSupersedes: number;
  /**
   * Folded duplicates whose hint was otherwise valid but left unapplied
   * because this invocation's {@link IMPORT_MAX_ITEMS} budget was already
   * spent. A folded hint is destructive — it retires a valid memory — yet it
   * mints nothing, so without its own budget an all-duplicates batch would
   * slip past the cap entirely and retire an unbounded number of memories
   * while reporting `droppedByCap: 0`. Same remedy as `droppedByCap`: re-run,
   * which converges (the items minted this round fold next round, freeing the
   * budget for the hints).
   *
   * #206 ②: a hint the budget cannot cover retires nothing, so hints that were
   * only ineligible BECAUSE of it become eligible and are counted here too.
   * That can exceed the number an unbounded budget would have honored (a
   * 3-link chain with no room reports 3, where room would honor 2) — deliberate:
   * every hint this call left unapplied is visible to the caller, and a re-run
   * settles the chain. Under-reporting would hide a retirement that did not
   * happen; over-reporting only asks for a re-run that converges.
   *
   * Not part of the `imported + skippedDuplicates + droppedByCap` partition —
   * these items are counted in `skippedDuplicates`; this refines WHY nothing
   * further happened for them.
   */
  droppedSupersedesByCap: number;
}

export interface ImportMemoriesParams {
  projectId: string;
  actor: string;
  /** Provenance label, e.g. `claude-memory`, `docs/adr` — stored on each memory. */
  source: string;
  /** Raw JSON text (typically stdin): an array of extractor-shaped items. */
  itemsJson: string;
  sessionId?: string;
  /** Contradiction-judge seam. Absent ⇒ `makeLlmJudge` never contradicts. */
  llm?: ConsolidatorLlm;
  /** Semantic index seam. Absent ⇒ embeddings and contradiction detection no-op. */
  embedder?: Embedder;
}

// #314 (#310 §Q6, docs/log-unique-constraint-b-residue-adjudication.md):
// this key's uniqueness is a DYNAMIC property, not a static one fixed at
// append time — it only holds above the `!invalidAt` + self-lane snapshot
// (readValidMemoriesFromLog's filter, line 246). Three paths legally re-append
// the same (kind, normalized text) below that snapshot, so a log-level
// unique constraint on it would reject all three:
//   - Re-import after supersede/invalidate: once a memory is invalidated its
//     `memory.consolidated` event stays in the append-only log, so a later
//     legitimate re-import of the same text is a new row colliding with that
//     stale one.
//   - Foreign lane: a synced sibling project's memory with the same text is
//     expected to coexist with a self-lane one (SoT-040) — the filter above
//     excludes it from the snapshot on purpose.
//   - Distillation x import: `memory.consolidated` events written by
//     consolidation never go through `textKey` at all, so the same text
//     arriving via distillation and via import is common and legal.
// It's also not SQL-reproducible: SQLite's `lower` is ASCII-only and `trim`
// strips spaces only, so an expression index on this normalization would
// enforce a second, WEAKER rule than this guard. A constraint is the wrong
// tool here — this stays a guard.
//
// TRIGGER: re-measure candidate 3 if normalized text becomes an actual stored
// column and the `invalidAt`/lane condition drops out of the dedup snapshot.

/** Same normalization the projection dedup uses for its text key. */
function textKey(kind: string, text: string): string {
  return `${kind}\n${text.trim().toLowerCase()}`;
}

/**
 * The still-valid self-lane memories, derived straight from the event log.
 *
 * #137 ③: this is what the idempotency guard needs — "the valid memory set
 * the durable log implies" — and nothing more. It used to be obtained by
 * rebuilding the shared projection first and then reading it back, but
 * `rebuildProjectProjection` is a replace-all whose read and write are NOT
 * atomic (it snapshots the log, then awaits topic `.md` reads, and only then
 * opens the DELETE-and-reload transaction). `importLocks` excludes other
 * IMPORTS, not the other writers that append + rebuild the same projection
 * (capture, consolidation), so an observation appended inside that window was
 * wiped from the projection by import's stale snapshot — and a duplicate-only
 * import appends nothing, so no later rebuild put it back.
 *
 * Deriving the snapshot in memory removes the destructive write entirely: a
 * read that writes nothing cannot roll back another writer. It also keeps the
 * #114 ② crash-window guarantee intact, because both fixes rest on the SAME
 * principle — the event log, not the projection cache, is the idempotency
 * source. Excluding concurrent writers from each other stays out of scope
 * (#132, and across processes); this path simply stops needing it.
 *
 * The filter mirrors `listValidMemories(projectId)` exactly: window still open
 * (`invalidAt` unset) and self-lane (a foreign writer's memory is not local
 * truth, SoT-040 — it must not silence a local import either).
 */
async function readValidMemoriesFromLog(
  projectId: string,
): Promise<{ memories: MemoryRecord[]; head: string | null }> {
  const events = await readEvents(projectId);
  const state = reduceProjectState(events, projectId);
  if (!state.project) {
    // Same refusal the rebuild this replaced raised, kept so importing into a
    // project with no genesis event still fails BEFORE anything is appended.
    throw new Error(`Project ${projectId} has no project.created event`);
  }
  return {
    memories: Object.values(state.memories).filter(
      (memory) => !memory.invalidAt && (memory.sourceProjectId ?? SELF_LANE) === SELF_LANE,
    ),
    // #253: the head OF THIS VERY READ, not a separate `readHeadEventId` call.
    // The dedup snapshot and the head it is certified by then come from one
    // array, so there is no ordering window between them at all — the two
    // cannot disagree about which appends they saw.
    head: events.at(-1)?.id ?? null,
  };
}

export async function importMemories(params: ImportMemoriesParams): Promise<MemoryImportResult> {
  const source = params.source.trim();
  if (!source) {
    throw new Error("memory import requires a non-empty source label");
  }

  // Whole body serialized per-project — see withProjectImportLock + module doc.
  return withProjectImportLock(params.projectId, async () => {
    // #253: `runImport` writes NOTHING before its `appendEvents` — it parses,
    // reads the dedup snapshot from the log, and builds the batch in memory —
    // so a compare-and-append refusal leaves the store byte-for-byte as it was
    // found and re-running the whole body is a clean retry, not a partial
    // redo. Retry (rather than propagate) is the right recovery HERE and not
    // at the other two adopted spans because import pays no LLM round trip to
    // rebuild its basis: the cost of losing the race is one more log replay.
    //
    // Bounded, not a `while (true)`: the head advancing forever means a writer
    // is appending faster than this call can replay the log, and silently
    // spinning on that would turn a contended store into a hang. Past the
    // budget the refusal propagates like any other failure, and the caller
    // (an agent invoking `memorize memory import`) can decide to try again.
    for (let attempt = 0; ; attempt += 1) {
      // "Nothing was written yet" is what makes the retry safe, so it is
      // OBSERVED rather than assumed. `runImport` also runs a post-append tail
      // (rebuild, embeddings, contradiction detection) and a stale-head
      // refusal surfacing from THERE would mean re-running an import whose
      // events are already durable — the dedup guard would fold them all and
      // report a batch of skipped duplicates, quietly turning a real failure
      // into a wrong-looking success. Retrying only before the append keeps
      // that impossible no matter what the tail grows into later.
      let appended = false;
      try {
        return await runImport(params, source, () => {
          appended = true;
        });
      } catch (error) {
        if (appended || attempt >= IMPORT_STALE_HEAD_RETRIES || !isStaleHeadError(error)) {
          throw error;
        }
      }
    }
  });
}

/** Extra attempts `importMemories` spends re-deriving its dedup snapshot after
 *  losing a compare-and-append race (#253). Two, because each retry costs one
 *  log replay and a store contended enough to lose three in a row has a
 *  problem a fourth replay will not solve. */
const IMPORT_STALE_HEAD_RETRIES = 2;

/** A folded duplicate's supersede hint, resolved to a concrete author + target. */
interface FoldedSupersedeCandidate {
  item: ExtractedMemory;
  supersededBy: string;
  target: string;
}

/** What {@link resolveFoldedHints} decided about the batch's folded hints. */
interface FoldedSupersedeResolution {
  /** Hints to write, in input order. */
  honored: FoldedSupersedeCandidate[];
  /**
   * Hints that won their target and whose author is alive, left unwritten
   * because the invocation budget was already spent — see
   * {@link MemoryImportResult.droppedSupersedesByCap}.
   */
  droppedByCap: number;
}

/**
 * The open candidates that sit on a cycle of the author-dependency graph —
 * the CYCLE CORE of {@link resolveFoldedHints} step 3.
 *
 * The edges are exactly what `authorSurvives` waits on: candidate c depends on
 * every OPEN candidate that targets c's author (`c.supersededBy`), because the
 * author's fate stays unknown until all of them are decided. A candidate is on
 * a cycle iff its strongly connected component has more than one member — a
 * one-member component would need a self-edge, i.e. `c.target ===
 * c.supersededBy`, which the static filter above already dropped, so it is
 * checked rather than assumed and costs one lookup.
 *
 * Being on a cycle is what makes a candidate irreducible: every candidate that
 * could settle its author is itself waiting, around the cycle, on this one. A
 * candidate merely queued BEHIND a cycle has no such edge back and is left
 * open on purpose — the next sweep is where it gets its turn (#222).
 *
 * Tarjan's algorithm, iterated with an explicit stack: the recursion depth
 * would otherwise be the candidate count, which is caller-supplied input.
 *
 * Cost is O(V+E) per stall and it is not paid repeatedly: deciding candidates
 * only ever REMOVES nodes (and with them edges), and removing nodes cannot
 * create a cycle — so once the first stall settles every candidate on a cycle,
 * what is left is a DAG and every later stall finds an empty core, which is
 * the loop's exit. The folded-hint count is not bounded by IMPORT_MAX_ITEMS
 * (the cap bounds hints APPLIED, not candidates), so this mattering is not
 * hypothetical.
 */
function findCyclicCore(open: ReadonlyArray<FoldedSupersedeCandidate>): FoldedSupersedeCandidate[] {
  /** Open rivals per target — the successor list of any candidate authored by it. */
  const openRivalsByTarget = new Map<string, FoldedSupersedeCandidate[]>();
  for (const candidate of open) {
    const rivals = openRivalsByTarget.get(candidate.target);
    if (rivals) rivals.push(candidate);
    else openRivalsByTarget.set(candidate.target, [candidate]);
  }
  const successorsOf = (candidate: FoldedSupersedeCandidate): FoldedSupersedeCandidate[] =>
    openRivalsByTarget.get(candidate.supersededBy) ?? [];

  const index = new Map<FoldedSupersedeCandidate, number>();
  const lowlink = new Map<FoldedSupersedeCandidate, number>();
  const onStack = new Set<FoldedSupersedeCandidate>();
  const componentStack: FoldedSupersedeCandidate[] = [];
  const core: FoldedSupersedeCandidate[] = [];
  let counter = 0;

  const enter = (
    node: FoldedSupersedeCandidate,
  ): { node: FoldedSupersedeCandidate; next: number } => {
    index.set(node, counter);
    lowlink.set(node, counter);
    counter += 1;
    componentStack.push(node);
    onStack.add(node);
    return { node, next: 0 };
  };

  for (const root of open) {
    if (index.has(root)) continue;
    const frames = [enter(root)];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const successors = successorsOf(frame.node);
      if (frame.next < successors.length) {
        const successor = successors[frame.next]!;
        frame.next += 1;
        if (!index.has(successor)) frames.push(enter(successor));
        else if (onStack.has(successor))
          lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, index.get(successor)!));
        continue;
      }
      frames.pop();
      if (lowlink.get(frame.node) === index.get(frame.node)) {
        const component: FoldedSupersedeCandidate[] = [];
        for (;;) {
          const member = componentStack.pop()!;
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) break;
        }
        if (component.length > 1 || successors.includes(frame.node)) core.push(...component);
      }
      const parent = frames[frames.length - 1];
      if (parent)
        lowlink.set(parent.node, Math.min(lowlink.get(parent.node)!, lowlink.get(frame.node)!));
    }
  }
  return core;
}

/**
 * #165: the folded-hint loop used to honor hints in a single sequential pass,
 * checking each one's `supersededBy` against only the retirements that had
 * already happened EARLIER in that same pass. That misses the reverse
 * order: hint A retires T naming M as successor, then a LATER hint B retires
 * M itself — T ends up pointing at a dead successor, and swapping A/B's
 * order in the input would have caught it (the existing guard is exactly
 * `retiredInBatch.has(supersededBy)`, it just runs too early for B's
 * retirement to be visible yet). The same batch must not honor or dangle
 * depending on incidental item order.
 *
 * #206: the first fix resolved that with a monotone EXCLUSION set — each round
 * dropped every survivor whose author was among that round's retired targets,
 * and a dropped candidate never came back. But a candidate's author is retired
 * only if the hint retiring it is itself honored, and that can stop being true
 * later in the same resolution (the hint gets excluded in turn, or the cap
 * below leaves it unwritten). Judging on "provisional survivors" and never
 * revisiting cost correctness in two ways:
 *
 * - a 3-link chain (c1: m retires t, c2: n retires m, c3: o retires n) excluded
 *   both c1 and c2 in round 1, and c2's exclusion means m LIVES — so c1 should
 *   have been honored and t retired. It stayed valid instead, silently.
 * - a hint dropped by the cap still counted as retiring its author's memory,
 *   so the candidate it excluded appeared in NEITHER the honored set nor
 *   `droppedSupersedesByCap` — an effect the caller could not see at all.
 *
 * So this resolves the whole set by DECIDING candidates outward from the ones
 * whose fate is already settled, instead of provisionally excluding them:
 *
 * 1. Build the candidate list from static facts only (target validity,
 *    self-reference, and anything already retired BEFORE the folded loop
 *    runs — i.e. by a new item's own hint, `staticRetired`). This part has
 *    no order dependency to begin with.
 * 2. Repeatedly sweep the undecided candidates in input order and decide the
 *    ones that can be decided. A candidate's author is known to SURVIVE when
 *    no candidate targets it at all (a freshly minted memory, or the `o` at
 *    the head of a chain), or when every candidate that targets it has already
 *    been decided against retiring it; it is known to be RETIRED once a hint
 *    targeting it is honored. With a surviving author, the candidate takes its
 *    target if no earlier rival for the same target is still pending (the same
 *    "first attribution wins" rule, now applied over decided rivals) — subject
 *    to the budget, see below. With a retired author it is ignored, which is
 *    what frees ITS target for the next sweep.
 * 3. A sweep that decides nothing does not mean the work is done: it proves
 *    that every candidate still open is either in an irreducible cycle (no
 *    sweep will ever settle its author) or is queued behind one for a target.
 *    Settle that CYCLE CORE — the open candidates that genuinely sit ON a
 *    cycle, see {@link findCyclicCore} — as ignored, all of it at once, and
 *    resume sweeping. The loop ends only when a stalled sweep leaves no core.
 *
 * Both halves of step 3 are load-bearing. Settling the core TOGETHER is what
 * keeps a mutual cycle (`a→b`, `b→a`) dropping both hints, which is the
 * standing contract: settling one at a time would leave `b→a` as the only
 * rival for a's target already decided, "proving" that a survives, and half of
 * a cycle with no stable assignment would get honored. And settling only the
 * CORE — not every open candidate — is what keeps an independent later rival
 * alive: with `b→a`, `a→b`, `c→a` in a batch, c is not in the cycle and its
 * author plainly survives, so once the core is out of the way c retires a
 * exactly as it did before this rewrite. Dropping the whole stalled set would
 * lose it in the return value entirely — neither honored nor a cap drop, the
 * very hole ② below closes.
 *
 * #222: the core used to be "every open candidate whose author's fate is
 * unknowable" (`authorSurvives(...) === undefined`), which is strictly WIDER
 * than the cycle. A candidate is caught by that test as soon as its author is
 * in a cycle — but sharing an author with the cycle is not being in it. With
 * `cX: a→b`, `cY: b→a`, `cZ: a→d`, the first stall settled all three, yet
 * dropping the cycle is exactly what proves a SURVIVES, so cZ was eligible on
 * the merits and d should have been retired. Being already decided, cZ never
 * came back — honored no, cap drop no, invisible to the caller, the same hole
 * ② closes at the cap boundary. The core is now the candidates on a cycle of
 * the author-dependency graph, and cZ (on no cycle) simply takes its turn in
 * the next sweep, where `authorSurvives(a) === true`.
 *
 * **What guarantees termination:** a decision is never revisited, and every
 * iteration makes at least one — either the sweep decides a candidate, or the
 * stall settles a non-empty cycle core. Narrowing the core to actual cycles
 * (#222) keeps that second half true; the argument, checkable against the code
 * above, is that at a stall with candidate set O still open:
 *
 * - every open candidate is (A) author-unknown, or (B) author-known but not
 *   the first open rival for its target. Nothing else survives a sweep: a
 *   retired author decides it ignored, a claimed target decides it ignored,
 *   and a known-surviving author that IS the first open rival decides it
 *   honored or capped.
 * - A is non-empty. Take any b in B; it is blocked by an open rival for its
 *   target, so that target has a FIRST open rival f, and f cannot be in B
 *   (nothing open precedes it for that target), so f is in A.
 * - every a in A has an open rival r for its author's target — that is what
 *   makes the author unknown — so the first open rival for `a.supersededBy`
 *   exists, and by the previous point it is itself in A. Call it `next(a)`:
 *   a total map A → A, and `a → next(a)` is a real edge of the dependency
 *   graph (`next(a).target === a.supersededBy`).
 * - a total self-map on a finite non-empty set has a cycle: iterate `next`
 *   from any member and some node must repeat. Those nodes are on a cycle of
 *   the dependency graph, hence in a component {@link findCyclicCore} returns.
 *
 * So a stall with anything still open yields a non-empty core, and the loop
 * cannot spin: at most `candidates.length` iterations. Nothing is ever
 * un-decided, which is exactly what the old exclusion set bought and this
 * keeps without paying in correctness.
 *
 * **Budget (#206 ②).** The cap is applied HERE rather than to the returned
 * list, because eligibility depends on which hints are actually written: a hint
 * the cap leaves unwritten retires nothing, so its author lives and the
 * candidates that would have been excluded by it stay eligible. A candidate
 * that wins its target with no budget left is therefore recorded as a cap drop
 * (visible to the caller, re-run converges it) and does NOT retire its target.
 * Statically ineligible hints never reach that point, so they are still not
 * miscounted as cap drops.
 */
function resolveFoldedHints(
  foldedHints: ReadonlyArray<{ textKey: string; item: ExtractedMemory }>,
  memoryIdByTextKey: ReadonlyMap<string, string>,
  validIds: ReadonlySet<string>,
  staticRetired: ReadonlySet<string>,
  budget: number,
): FoldedSupersedeResolution {
  const candidates: FoldedSupersedeCandidate[] = [];
  for (const folded of foldedHints) {
    const supersededBy = memoryIdByTextKey.get(folded.textKey);
    const target = folded.item.supersedesMemoryId;
    if (
      !supersededBy ||
      !target ||
      !validIds.has(target) ||
      target === supersededBy ||
      staticRetired.has(target) ||
      staticRetired.has(supersededBy)
    ) {
      continue;
    }
    candidates.push({ item: folded.item, supersededBy, target });
  }

  /** Rivals for the same target, in input order — "first attribution wins". */
  const rivalsByTarget = new Map<string, FoldedSupersedeCandidate[]>();
  for (const candidate of candidates) {
    const rivals = rivalsByTarget.get(candidate.target);
    if (rivals) rivals.push(candidate);
    else rivalsByTarget.set(candidate.target, [candidate]);
  }

  const decisions = new Map<FoldedSupersedeCandidate, "honored" | "capped" | "ignored">();
  /** Targets an honored hint actually retires. */
  const retired = new Set<string>();
  /** Targets whose winner is settled — honored OR capped; rivals lose either way. */
  const claimed = new Set<string>();

  /** true = author outlives this batch, false = retired by it, undefined = still open. */
  const authorSurvives = (id: string): boolean | undefined => {
    if (retired.has(id)) return false;
    const rivals = rivalsByTarget.get(id);
    if (!rivals) return true;
    return rivals.every((rival) => decisions.has(rival)) ? true : undefined;
  };

  let remaining = budget;
  let droppedByCap = 0;
  for (;;) {
    let progressed = false;
    for (const candidate of candidates) {
      if (decisions.has(candidate)) continue;
      const survives = authorSurvives(candidate.supersededBy);
      if (survives === undefined) continue;
      if (!survives || claimed.has(candidate.target)) {
        decisions.set(candidate, "ignored");
        progressed = true;
        continue;
      }
      // An earlier rival that is still open may yet take this target.
      if (
        rivalsByTarget.get(candidate.target)?.find((rival) => !decisions.has(rival)) !== candidate
      )
        continue;
      if (remaining > 0) {
        remaining -= 1;
        decisions.set(candidate, "honored");
        retired.add(candidate.target);
      } else {
        decisions.set(candidate, "capped");
        droppedByCap += 1;
      }
      claimed.add(candidate.target);
      progressed = true;
    }
    if (progressed) continue;
    // A sweep that decides nothing is not "done" — it is proof that every
    // candidate still open is either in an irreducible cycle (no sweep will
    // ever settle its author) or queued behind one for a target. Settle that
    // cycle core as ignored and resume; only an empty core ends the loop.
    // Both halves of "the core, all of it, at once" are load-bearing, and the
    // core is the candidates ON a cycle rather than every one whose author is
    // undecided (#222) — see the function doc, including why a stall with
    // anything still open always leaves a non-empty core.
    const cyclicCore = findCyclicCore(candidates.filter((candidate) => !decisions.has(candidate)));
    if (cyclicCore.length === 0) break;
    for (const candidate of cyclicCore) decisions.set(candidate, "ignored");
  }

  return {
    honored: candidates.filter((candidate) => decisions.get(candidate) === "honored"),
    droppedByCap,
  };
}

async function runImport(
  params: ImportMemoriesParams,
  source: string,
  /** Called the instant this call's batch is durable, so `importMemories` can
   *  tell a pre-append failure (safely retryable) from a post-append one. */
  onAppended: () => void,
): Promise<MemoryImportResult> {
  // Same defensive parser as the consolidation extractors: locates the JSON
  // array, drops malformed entries, sanitizes lifecycle-evidence fields.
  // Throws ExtractionParseError when there is no parseable array at all.
  //
  // #114 ①: unbounded here on purpose. IMPORT_MAX_ITEMS is applied further
  // down, AFTER the idempotency guard, so items that are only "new" because
  // they sort past a run of pre-existing duplicates are never discarded
  // before they get a chance to be counted as duplicates or as genuinely new.
  const parsedItems = parseExtractedMemories(params.itemsJson, {
    maxItems: Number.POSITIVE_INFINITY,
  });
  if (parsedItems.length === 0) {
    // Distinct from consolidation: an extractor may legitimately find nothing
    // in a window, but an agent invoking import with zero valid items is a
    // malformed call — fail loud, write nothing.
    throw new ExtractionParseError("memory import: no valid memory items in input");
  }

  // #114 ② / #137 ③: the idempotency guard reads the durable event log, not
  // the projection cache. Closes the crash window where a prior call appended
  // events but died before its own rebuild (a projection read would not know
  // about those memories and would re-import them) WITHOUT rewriting the
  // shared projection to get there — see readValidMemoriesFromLog.
  const { memories: existingMemories, head: expectedHead } = await readValidMemoriesFromLog(
    params.projectId,
  );
  // Idempotency guard: imported memories have EMPTY sourceObservationIds,
  // which the projection dedup never groups — a re-run would silently
  // duplicate. Skip items whose kind+normalized text already exists as a
  // valid memory instead.
  //
  // The map is text key -> the memory that key resolves to, not just the set
  // of keys: a folded duplicate still needs to name a memory as the author of
  // its supersede hint (#137 ②). First writer wins, so a pre-existing memory
  // is preferred over one minted later in this same batch.
  const memoryIdByTextKey = new Map<string, string>();
  for (const memory of existingMemories) {
    const key = textKey(memory.kind, memory.text);
    if (!memoryIdByTextKey.has(key)) memoryIdByTextKey.set(key, memory.id);
  }
  // Supersede targets: only an id that is CURRENTLY valid may be superseded —
  // same guard as consolidate-service, applied here so import-provided
  // supersede hints are honored instead of silently dropped (#114 ③).
  const validIds = new Set(existingMemories.map((memory) => memory.id));

  let skippedDuplicates = 0;
  const uniqueNewItems: ExtractedMemory[] = [];
  const seenTextKeys = new Set(memoryIdByTextKey.keys());
  // #137 ②: a duplicate's TEXT is redundant, its supersede hint is not. The
  // item is still folded (no second copy of the same memory is minted), but
  // the hint is carried out of the loop and resolved below instead of dying
  // with the `continue` — the very thing the guard above promises not to do.
  const foldedHints: Array<{ textKey: string; item: ExtractedMemory }> = [];
  for (const item of parsedItems) {
    const key = textKey(item.kind, item.text);
    if (seenTextKeys.has(key)) {
      skippedDuplicates += 1;
      if (item.supersedesMemoryId) foldedHints.push({ textKey: key, item });
      continue;
    }
    seenTextKeys.add(key); // in-batch dedup too
    uniqueNewItems.push(item);
  }

  // Cap AFTER dedup (#114 ①): the cap bounds genuinely new work, not the
  // input size. Anything beyond it is reported via droppedByCap rather than
  // silently vanishing — 0 imported / N duplicates can no longer mean
  // "everything past the cap was lost and nobody can tell."
  const droppedByCap = Math.max(0, uniqueNewItems.length - IMPORT_MAX_ITEMS);
  const items = uniqueNewItems.slice(0, IMPORT_MAX_ITEMS);

  const inputs: AppendEventInput<ConsolidatedMemory | MemorySupersededPayload>[] = [];
  let honoredSupersedes = 0;

  /** Ids this batch has already retired — see {@link supersedeTargetFor}. */
  const retiredInBatch = new Set<string>();

  /**
   * The id `item`'s hint may retire on behalf of `supersededBy`, or undefined
   * if the hint must be ignored. Both hint paths (new item / folded duplicate)
   * go through here so the discipline cannot diverge between them:
   *
   * - Only a CURRENTLY valid id may be superseded — a hallucinated or stale id
   *   must not produce a dangling event. Mirrors consolidate-service's own
   *   supersede handling exactly (#114 ③), and a target already retired
   *   earlier in this same batch is no longer valid either.
   * - A memory may not name itself: a duplicate folded INTO its own supersede
   *   target would otherwise invalidate the memory the hint is attributed to.
   * - The ATTRIBUTED memory must not itself have been retired by this batch.
   *   Only the folded path can hit this (a freshly minted memory is never a
   *   target, since targets must be pre-existing): one item mints a
   *   replacement for A while a later item folds INTO A and claims to retire
   *   B. Honoring it would retire B naming the already-dead A as its
   *   replacement, leaving B with no valid successor.
   */
  const supersedeTargetFor = (item: ExtractedMemory, supersededBy: string): string | undefined => {
    const target = item.supersedesMemoryId;
    if (!target || !validIds.has(target) || retiredInBatch.has(target)) return undefined;
    if (target === supersededBy || retiredInBatch.has(supersededBy)) return undefined;
    return target;
  };

  /** Write the `memory.superseded` event for an already-vetted hint. */
  const honorSupersedeHint = (
    item: ExtractedMemory,
    supersededBy: string,
    target: string,
  ): void => {
    inputs.push({
      type: "memory.superseded",
      projectId: params.projectId,
      scopeType: "session",
      scopeId: params.sessionId ?? params.projectId,
      actor: params.actor,
      payload: {
        supersedes: target,
        supersededBy,
        reason: item.supersedeReason ?? "Superseded by imported memory",
      },
    });
    retiredInBatch.add(target);
    honoredSupersedes += 1;
  };

  for (const item of items) {
    const memory = createConsolidatedMemory({
      projectId: params.projectId,
      kind: item.kind,
      text: item.text,
      salience: item.salience,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      sourceObservationIds: [],
      ...(item.obsoleteWhen ? { obsoleteWhen: item.obsoleteWhen } : {}),
      ...(item.kindMisfit ? { kindMisfit: true } : {}),
      ...(item.kindMisfitReason ? { kindMisfitReason: item.kindMisfitReason } : {}),
      ...(item.supersedesNote ? { supersedesNote: item.supersedesNote } : {}),
      ...(item.tags ? { tags: item.tags } : {}),
      importSource: source,
    });
    inputs.push({
      type: "memory.consolidated",
      projectId: params.projectId,
      scopeType: "session",
      scopeId: params.sessionId ?? params.projectId,
      actor: params.actor,
      payload: memory,
    });
    // This memory is now what its text key resolves to, so a duplicate later
    // in the batch can attribute its hint to it (#137 ②).
    memoryIdByTextKey.set(textKey(item.kind, item.text), memory.id);

    const target = supersedeTargetFor(item, memory.id);
    if (target) honorSupersedeHint(item, memory.id, target);
  }

  // #137 ②: hints carried by folded duplicates. Resolved HERE, after the cap,
  // so a hint can only ever be attributed to a memory that this call actually
  // mints (or that already exists) — a duplicate of an in-batch item the cap
  // dropped has no author and is dropped with it, rather than emitting a
  // supersede event on behalf of a memory that was never written.
  //
  // Attribution: the memory the duplicate folded INTO. The item's claim is
  // "this text replaces `oldId`", and that text is already present as that
  // memory — re-minting a second copy just to carry the hint is exactly the
  // duplication the idempotency guard exists to prevent.
  //
  // #165: eligibility of one folded hint can depend on ANOTHER folded hint in
  // the same batch (one hint's `supersededBy` can be the very memory a later
  // hint retires), so this can't be a single sequential pass over
  // `foldedHints` — that only ever sees retirements that happened EARLIER in
  // iteration order, and the same batch content honors or dangles depending
  // on which order the items happened to arrive in. Resolving the whole set
  // at once makes the result order-independent.
  //
  // A folded hint mints nothing, so it consumes none of the cap above — but it
  // still RETIRES a valid memory, and an all-duplicates batch produces no
  // `uniqueNewItems` at all. Left unbudgeted, a 5000-item dump of existing
  // texts each naming a distinct target would retire 5000 memories while
  // reporting `droppedByCap: 0`, defeating the very guard the cap exists for.
  // So folded hints spend the room the minted items left behind (both are
  // "items of this call that take effect"), and the overflow is reported.
  // #206 ②: that budget is spent INSIDE the resolution rather than on its
  // result, because a hint the cap cannot write retires nothing — the
  // candidates it would have excluded are still live and must be reported
  // rather than dropped on the floor. Statically ineligible hints are filtered
  // before the budget is consulted, so they are still not counted as cap drops.
  const foldedResolution = resolveFoldedHints(
    foldedHints,
    memoryIdByTextKey,
    validIds,
    retiredInBatch,
    IMPORT_MAX_ITEMS - items.length,
  );
  for (const candidate of foldedResolution.honored) {
    honorSupersedeHint(candidate.item, candidate.supersededBy, candidate.target);
  }
  const droppedSupersedesByCap = foldedResolution.droppedByCap;

  if (inputs.length > 0) {
    // #253: compare-and-append against the head the dedup snapshot above was
    // read at. Import has NO cross-process lock (see module doc), so this is
    // the only thing standing between a concurrent writer and a duplicate
    // import: the guard's whole premise is that `existingMemories` still
    // describes the log. A refusal is recovered by the retry in
    // `importMemories` — nothing durable has been written at this point, so
    // re-deriving the snapshot is both safe and free of any LLM cost.
    await appendEvents(params.projectId, inputs, { expectedHead });
    onAppended();
    // Same post-append duties as a consolidation boundary: make the new
    // memories searchable, embed them (best-effort), and let imported
    // decisions face contradiction detection against existing ones.
    await rebuildProjectProjection(params.projectId, { reindexSearch: true });
    await ensureEmbeddings(params.projectId, params.embedder);
    await detectContradictions({
      projectId: params.projectId,
      ...(params.embedder ? { embedder: params.embedder } : {}),
      judge: makeLlmJudge(params.llm),
      actor: params.actor,
    });
  }

  return {
    imported: items.length,
    skippedDuplicates,
    droppedByCap,
    honoredSupersedes,
    droppedSupersedesByCap,
  };
}

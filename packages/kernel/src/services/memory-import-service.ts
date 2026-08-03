import {
  createConsolidatedMemory,
  type ConsolidatedMemory,
  type MemorySupersededPayload,
} from "../domain/entities.js";
import type { ConsolidatorLlm, Embedder } from "../index.js";
import { reduceProjectState, SELF_LANE } from "../projections/projector.js";
import type { MemoryRecord } from "../projections/projector.js";
import { appendEvents, readEvents, type AppendEventInput } from "../storage/event-store.js";
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
async function readValidMemoriesFromLog(projectId: string): Promise<MemoryRecord[]> {
  const state = reduceProjectState(await readEvents(projectId), projectId);
  if (!state.project) {
    // Same refusal the rebuild this replaced raised, kept so importing into a
    // project with no genesis event still fails BEFORE anything is appended.
    throw new Error(`Project ${projectId} has no project.created event`);
  }
  return Object.values(state.memories).filter(
    (memory) => !memory.invalidAt && (memory.sourceProjectId ?? SELF_LANE) === SELF_LANE,
  );
}

export async function importMemories(params: ImportMemoriesParams): Promise<MemoryImportResult> {
  const source = params.source.trim();
  if (!source) {
    throw new Error("memory import requires a non-empty source label");
  }

  // Whole body serialized per-project — see withProjectImportLock + module doc.
  return withProjectImportLock(params.projectId, () => runImport(params, source));
}

/** A folded duplicate's supersede hint, resolved to a concrete author + target. */
interface FoldedSupersedeCandidate {
  item: ExtractedMemory;
  supersededBy: string;
  target: string;
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
 * This resolves the whole set to a fixed point instead of one pass:
 *
 * 1. Build the candidate list from static facts only (target validity,
 *    self-reference, and anything already retired BEFORE the folded loop
 *    runs — i.e. by a new item's own hint, `staticRetired`). This part has
 *    no order dependency to begin with.
 * 2. Repeatedly: pick the first surviving candidate per target (same
 *    "first attribution wins" rule as before, now recomputed every round
 *    instead of frozen at first pass), then drop any survivor whose
 *    `supersededBy` is itself one of this round's retired targets. Dropping
 *    a candidate can free its target back up for a competitor that lost the
 *    dedup earlier — recomputing dedup from the full remaining candidate set
 *    every round (not just the previous survivors) is what lets that
 *    competitor be picked up.
 *
 * The exclusion set only ever grows and is bounded by the candidate count, so
 * this always terminates — there is no oscillation to guard against.
 */
function resolveFoldedHintsFixedPoint(
  foldedHints: ReadonlyArray<{ textKey: string; item: ExtractedMemory }>,
  memoryIdByTextKey: ReadonlyMap<string, string>,
  validIds: ReadonlySet<string>,
  staticRetired: ReadonlySet<string>,
): FoldedSupersedeCandidate[] {
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

  const excluded = new Set<FoldedSupersedeCandidate>();
  let survivors = new Set<FoldedSupersedeCandidate>();
  for (;;) {
    const retiredTargets = new Set<string>();
    survivors = new Set();
    for (const candidate of candidates) {
      if (excluded.has(candidate) || retiredTargets.has(candidate.target)) continue;
      retiredTargets.add(candidate.target);
      survivors.add(candidate);
    }

    let changed = false;
    for (const candidate of survivors) {
      if (retiredTargets.has(candidate.supersededBy)) {
        excluded.add(candidate);
        survivors.delete(candidate);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return candidates.filter((candidate) => survivors.has(candidate));
}

async function runImport(
  params: ImportMemoriesParams,
  source: string,
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
  const existingMemories = await readValidMemoriesFromLog(params.projectId);
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
  // on which order the items happened to arrive in. Resolving to a fixed
  // point first makes the result order-independent.
  const eligibleFoldedHints = resolveFoldedHintsFixedPoint(
    foldedHints,
    memoryIdByTextKey,
    validIds,
    retiredInBatch,
  );

  // A folded hint mints nothing, so it consumes none of the cap above — but it
  // still RETIRES a valid memory, and an all-duplicates batch produces no
  // `uniqueNewItems` at all. Left unbudgeted, a 5000-item dump of existing
  // texts each naming a distinct target would retire 5000 memories while
  // reporting `droppedByCap: 0`, defeating the very guard the cap exists for.
  // So folded hints spend the room the minted items left behind (both are
  // "items of this call that take effect"), and the overflow is reported.
  // Eligibility (including the #165 fixed point above) is judged BEFORE the
  // budget so hints that would have been ignored anyway are not miscounted as
  // cap drops.
  let supersedeBudget = IMPORT_MAX_ITEMS - items.length;
  let droppedSupersedesByCap = 0;
  for (const candidate of eligibleFoldedHints) {
    if (supersedeBudget === 0) {
      droppedSupersedesByCap += 1;
      continue;
    }
    supersedeBudget -= 1;
    honorSupersedeHint(candidate.item, candidate.supersededBy, candidate.target);
  }

  if (inputs.length > 0) {
    await appendEvents(params.projectId, inputs);
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

import {
  createConsolidatedMemory,
  type ConsolidatedMemory,
  type MemorySupersededPayload,
} from "../domain/entities.js";
import type { ConsolidatorLlm, Embedder } from "../index.js";
import { appendEvents, type AppendEventInput } from "../storage/event-store.js";
import {
  ExtractionParseError,
  parseExtractedMemories,
  type ExtractedMemory,
} from "./consolidate-service.js";
import { detectContradictions, makeLlmJudge } from "./contradiction-service.js";
import { ensureEmbeddings } from "./embeddings-service.js";
import { listValidMemories, rebuildProjectProjection } from "./projection-store.js";

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
 *   (#114): the idempotency guard reads a projection snapshot, and awaiting
 *   `appendEvents` yields the event loop to any other pending call. Two fixes
 *   below close that, without a cross-process file lock:
 *   1. {@link withProjectImportLock} serializes the ENTIRE body per
 *      `projectId` (a same-process promise-chain mutex) — a second call for
 *      the same project simply waits its turn instead of reading a
 *      snapshot the first call is about to invalidate.
 *   2. Every call opens by rebuilding the projection from the event log
 *      BEFORE reading it for dedup, so a prior call that appended events but
 *      died before its own rebuild (crash between `appendEvents` and
 *      `rebuildProjectProjection`) cannot cause the next call to re-derive a
 *      stale "not a duplicate" answer — the event log, not the projection
 *      cache, is the durable idempotency source.
 * - **No env/config resolution for the LLM judge.** `llm`/`embedder` are
 *   injected by the caller, same seam discipline as `consolidate()`.
 */

/**
 * Per-project promise-chain mutex. Serializes overlapping `importMemories`
 * calls for the same project so the read-dedup-append sequence of one call
 * can never interleave with another's (see module doc, fix 1). Chained
 * continuations always resolve (never reject) so one call's failure never
 * jams the queue for the next.
 */
const importLocks = new Map<string, Promise<void>>();

async function withProjectImportLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const previous = importLocks.get(projectId) ?? Promise.resolve();
  const turn = previous.then(fn, fn);
  importLocks.set(
    projectId,
    turn.then(
      () => undefined,
      () => undefined,
    ),
  );
  return turn;
}

/**
 * Per-invocation cap. Far above the boundary consolidation noise guard (12):
 * a one-time distillation of weeks of harness memory or an ADR folder
 * legitimately yields dozens of items; anything past this is probably an
 * unreviewed dump.
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

export async function importMemories(params: ImportMemoriesParams): Promise<MemoryImportResult> {
  const source = params.source.trim();
  if (!source) {
    throw new Error("memory import requires a non-empty source label");
  }

  // Whole body serialized per-project — see withProjectImportLock + module doc.
  return withProjectImportLock(params.projectId, () => runImport(params, source));
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

  // #114 ②: resync the projection from the durable event log BEFORE reading
  // it for the idempotency guard. Closes the crash window where a prior call
  // appended events but died before its own rebuild — without this, the next
  // call would read a projection that doesn't know about those memories yet
  // and re-import (and re-append) them.
  await rebuildProjectProjection(params.projectId, { reindexSearch: true });

  const existingMemories = listValidMemories(params.projectId).map((row) => row.memory);
  // Idempotency guard: imported memories have EMPTY sourceObservationIds,
  // which the projection dedup never groups — a re-run would silently
  // duplicate. Skip items whose kind+normalized text already exists as a
  // valid memory instead.
  const existingTextKeys = new Set(
    existingMemories.map((memory) => textKey(memory.kind, memory.text)),
  );
  // Supersede targets: only an id that is CURRENTLY valid may be superseded —
  // same guard as consolidate-service, applied here so import-provided
  // supersede hints are honored instead of silently dropped (#114 ③).
  const validIds = new Set(existingMemories.map((memory) => memory.id));

  let skippedDuplicates = 0;
  const uniqueNewItems: ExtractedMemory[] = [];
  for (const item of parsedItems) {
    const key = textKey(item.kind, item.text);
    if (existingTextKeys.has(key)) {
      skippedDuplicates += 1;
      continue;
    }
    existingTextKeys.add(key); // in-batch dedup too
    uniqueNewItems.push(item);
  }

  // Cap AFTER dedup (#114 ①): the cap bounds genuinely new work, not the
  // input size. Anything beyond it is reported via droppedByCap rather than
  // silently vanishing — 0 imported / N duplicates can no longer mean
  // "everything past the cap was lost and nobody can tell."
  const droppedByCap = Math.max(0, uniqueNewItems.length - IMPORT_MAX_ITEMS);
  const items = uniqueNewItems.slice(0, IMPORT_MAX_ITEMS);

  const inputs: AppendEventInput<ConsolidatedMemory | MemorySupersededPayload>[] = [];
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

    // Only supersede memories that actually exist and are still valid — a
    // hallucinated or stale id must not produce a dangling event. Mirrors
    // consolidate-service's own supersede handling exactly (#114 ③).
    if (item.supersedesMemoryId && validIds.has(item.supersedesMemoryId)) {
      inputs.push({
        type: "memory.superseded",
        projectId: params.projectId,
        scopeType: "session",
        scopeId: params.sessionId ?? params.projectId,
        actor: params.actor,
        payload: {
          supersedes: item.supersedesMemoryId,
          supersededBy: memory.id,
          reason: item.supersedeReason ?? "Superseded by imported memory",
        },
      });
      validIds.delete(item.supersedesMemoryId);
    }
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

  return { imported: items.length, skippedDuplicates, droppedByCap };
}

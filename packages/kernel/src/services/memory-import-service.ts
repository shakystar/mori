import { createConsolidatedMemory, type ConsolidatedMemory } from "../domain/entities.js";
import type { ConsolidatorLlm, Embedder } from "../index.js";
import { appendEvents, type AppendEventInput } from "../storage/event-store.js";
import { ExtractionParseError, parseExtractedMemories } from "./consolidate-service.js";
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
 * - **No file lock.** memorize serialized concurrent imports/boundaries with a
 *   per-project lock file guarding detached CLI subprocesses racing each
 *   other. Here this is an in-process call on the kernel seam — there is no
 *   second process to serialize against.
 * - **No env/config resolution for the LLM judge.** `llm`/`embedder` are
 *   injected by the caller, same seam discipline as `consolidate()`.
 */

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

  // Same defensive parser as the consolidation extractors: locates the JSON
  // array, drops malformed entries, sanitizes lifecycle-evidence fields.
  // Throws ExtractionParseError when there is no parseable array at all.
  const items = parseExtractedMemories(params.itemsJson, { maxItems: IMPORT_MAX_ITEMS });
  if (items.length === 0) {
    // Distinct from consolidation: an extractor may legitimately find nothing
    // in a window, but an agent invoking import with zero valid items is a
    // malformed call — fail loud, write nothing.
    throw new ExtractionParseError("memory import: no valid memory items in input");
  }

  // Idempotency guard: imported memories have EMPTY sourceObservationIds,
  // which the projection dedup never groups — a re-run would silently
  // duplicate. Skip items whose kind+normalized text already exists as a
  // valid memory instead.
  const existing = new Set(
    listValidMemories(params.projectId).map((row) => textKey(row.memory.kind, row.memory.text)),
  );

  const inputs: AppendEventInput<ConsolidatedMemory>[] = [];
  let skippedDuplicates = 0;
  for (const item of items) {
    const key = textKey(item.kind, item.text);
    if (existing.has(key)) {
      skippedDuplicates += 1;
      continue;
    }
    existing.add(key); // in-batch dedup too

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

  return { imported: inputs.length, skippedDuplicates };
}

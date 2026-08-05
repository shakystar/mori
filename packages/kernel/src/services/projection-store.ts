import type Database from "better-sqlite3";

import type {
  Checkpoint,
  Conflict,
  Decision,
  Handoff,
  MemoryIndex,
  Project,
  Rule,
  Session,
  Task,
  TaskRequest,
  TaskRequestStatus,
  Workstream,
} from "../domain/entities.js";
import { TERMINAL_CONFLICT_STATUSES } from "../domain/state-machines.js";
import {
  buildMemoryIndex,
  parseLaneKey,
  reduceProjectState,
  SELF_LANE,
} from "../projections/projector.js";
import type { MemoryRecord, ObservationRecord, ProjectState } from "../projections/projector.js";
import { getDb } from "../storage/db.js";
import { listSegments } from "./segment-store.js";
import { headEventId, readEvents, readEventsUpTo } from "../storage/event-store.js";
import { readJson, writeJson } from "../storage/fs-utils.js";
import { getTopicFile } from "../storage/path-resolver.js";

/**
 * The persisted shape of the memory index. buildMemoryIndex returns
 * `mustReadTopics[].path` as a `topic:<ruleId>` placeholder; we rewrite it to
 * the on-disk topic file path here so renderers / readers can open the file.
 * Topics themselves stay as `.md` content files (not a projection table) —
 * they are agent-readable content artifacts referenced by path, not query
 * projections.
 */
export type PersistedMemoryIndex = MemoryIndex;

// --- write side ------------------------------------------------------------

/** Searchable entity kinds indexed into `search_fts`. */
export type SearchKind =
  "task" | "handoff" | "decision" | "checkpoint" | "topic" | "memory" | "segment";

/**
 * Flatten an entity's human-text fields into a single FTS document. Skips
 * empty/undefined parts and collapses whitespace so blank fields never add
 * noise. The result is plain content (no FTS5 operators) — it is inserted as
 * a bound parameter, never interpolated.
 */
function searchText(parts: ReadonlyArray<string | undefined>): string {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

/**
 * The `source_project_id` column value for a composite state-map key (M2). Self
 * rows store NULL (matching the events-table convention that NULL = self), so a
 * single-writer store's projection tables are byte-identical to pre-M2; a
 * foreign-lane row stores its origin store id for the private-vs-union selector.
 */
function laneColumn(compositeKey: string): string | null {
  const { lane } = parseLaneKey(compositeKey);
  return lane === SELF_LANE ? null : lane;
}

/** Read-side lane scope for {@link laneWhere}. */
export type ProjectionLane = "self" | "union";

/**
 * The single private-vs-union lane predicate (M2, SoT-040). Every projection
 * read that must not fold a foreign writer's row into local truth builds its
 * WHERE through this ONE helper instead of branching inline. `self` (the
 * default, and the only lane with data pre-W3) keeps just this store's own rows
 * (`source_project_id IS NULL`); `union` admits every writer's rows so the
 * caller can group by lane and render them as a labelled shared channel. The
 * result is a constant SQL boolean over a real column — no bound params, no
 * user input, safe to concatenate.
 *
 * Does NOT need `laneOf`/`laneWhereSql` (#143) to derive this: a projection
 * row's `source_project_id` is written by the SAME code that computes
 * `eventLane = laneOf(...)` for that row (see `reduceProjectState`'s
 * per-entity-type cases) and is stored as NULL precisely when that lane is
 * `SELF_LANE`, non-NULL otherwise. So `source_project_id IS NULL` here and
 * `laneOf(...) === SELF_LANE` there cannot disagree — the column IS the
 * classification's output, already materialized once at projection time, not
 * a second, independently-derived self test on the raw
 * `project_id`/`source_project_id` pair the way `laneWhereSql` is for the
 * (unprojected) `events` table.
 */
export function laneWhere(lane: ProjectionLane = "self"): string {
  return lane === "self" ? "source_project_id IS NULL" : "1 = 1";
}

const SINGLETON_TABLES = ["projects", "memory_index"] as const;
const ENTITY_TABLES = [
  "workstreams",
  "tasks",
  "task_requests",
  "handoffs",
  "checkpoints",
  "decisions",
  "rules",
  "conflicts",
  "sessions",
  "observations",
  "memories",
] as const;

/**
 * Options for {@link rebuildProjectProjection}.
 */
export interface RebuildProjectProjectionOptions {
  /**
   * Whether to reindex the `search_fts` table as part of the rebuild.
   * Defaults to `true` (every existing call site is unchanged). Pass
   * `false` ONLY when BOTH hold: (1) the triggering event(s) cannot create
   * or modify any searchable entity (task / handoff / decision / checkpoint
   * / imported-topic rule / memory / segment) — e.g. pure session-state
   * events like heartbeats — AND (2) no OTHER writer can have created or
   * modified a searchable entity since the last `reindexSearch: true`
   * rebuild, through EITHER channel: an event-log append, or a direct write
   * to a table this rebuild reads without going through the log at all
   * (segments: `insertSegments` in consolidate-service.ts writes the
   * `segments` table directly — no event is appended — and this rebuild's
   * `listSegments(projectId, "union")` reads it back on every full reindex).
   *
   * (2) is NOT a property of the triggering event alone: every rebuild
   * replays the FULL log (`attemptProjectionRebuild`), so a searchable
   * entity ANY writer appended — or, for segments, wrote directly — is
   * already reflected in the projection TABLES below (unconditional) the
   * moment any rebuild runs, but only reaches `search_fts` on a
   * `reindexSearch: true` rebuild — skip the wipe/reindex while such an
   * entity is unindexed and it stays unindexed until the next full reindex.
   * (#277, #189 residue ㉮.) Reasoning about (2) purely as "did anything
   * append to the log" misses the segment path (PR #279 review, Codex P2):
   * a conversation-only consolidation boundary (no memories extracted, so no
   * `memory.consolidated` append) can still write segments directly.
   *
   * Today (2) holds for capture-service.ts's `captureObservation` — the
   * only `reindexSearch: false` caller — because every call path that CAN
   * create or modify a searchable entity, through either channel, always
   * requests `reindexSearch: true`:
   * - `consolidateBoundary` (consolidate-service.ts) requests it
   *   unconditionally, including on the segments-only branch above — its own
   *   `rebuildProjectProjection` call is gated on `inputs.length > 0 ||
   *   segmentsWritten > 0`, not on whether an event was appended, so the
   *   direct-write segment path above still gets a `reindexSearch: true`
   *   rebuild from the SAME call that did the writing.
   * - `detectContradictions`, nested inside it, requests it too.
   *
   * Under NORMAL operation this cannot interleave with capture: all three
   * run under the same per-project `withProjectLock` (project-lock.ts). That
   * lock is not absolute mutual exclusion, though, and this invariant leans
   * on it — project-lock.ts's "The overlap that remains" documents a narrow,
   * pre-existing race (lock dispossession + a third acquirer racing a
   * restore) where a dispossessed holder's tail — which is exactly
   * `rebuildProjectProjection`/`detectContradictions` above, both already
   * marked UNSAFE-to-the-replace-all there for unrelated reasons — can still
   * be in flight when a new holder starts a `reindexSearch: false` capture.
   * That race is not introduced or widened by this invariant (it predates
   * #277 and affects other lock-protected sections the same way), is not
   * evaluated further here, and is the one condition under which (2) can
   * fail today (PR #279 review, Codex P2).
   *
   * The two service functions that also default to `reindexSearch: true`
   * but are NOT lock-protected — `importMemories` (memory-import-service.ts)
   * and `resolveConflict` (conflict-service.ts) — have no reachable caller
   * in this package's current wiring (neither is exported from `index.ts`,
   * nor called from `SqliteMemoryKernel`), so they cannot race capture in
   * production as it stands. This is an invariant spread across four files,
   * not something the type system enforces: a future writer that can create
   * or modify a searchable entity (through a log append OR a direct table
   * write) while skipping the reindex, or a new caller that reaches
   * `importMemories` / `resolveConflict` outside the project lock, would
   * silently reopen this gap — grep this file's `SearchKind` producers
   * before adding one.
   *
   * Skipping the reindex leaves the existing `search_fts` rows untouched
   * while the projection TABLES are still fully rebuilt. Over-reindexing is
   * correct (just slower); skipping while a searchable entity may be
   * unindexed is a BUG.
   */
  reindexSearch?: boolean;
}

/**
 * Historical duplicates: pre-idempotent-import re-runs minted multiple
 * imported rules for the same context file (same title, different ids).
 * The event log keeps them all (append-only); derived surfaces show one
 * topic per title — the freshest. Tie-break on id for determinism.
 */
function latestImportedRules(rules: Record<string, Rule>): Rule[] {
  const byTitle = new Map<string, Rule>();
  for (const rule of Object.values(rules)) {
    if (rule.source !== "imported") continue;
    const prev = byTitle.get(rule.title);
    if (
      !prev ||
      rule.updatedAt > prev.updatedAt ||
      (rule.updatedAt === prev.updatedAt && rule.id > prev.id)
    ) {
      byTitle.set(rule.title, rule);
    }
  }
  return [...byTitle.values()];
}

/** What a {@link rebuildProjectProjection} call did. */
export interface RebuildProjectProjectionResult {
  /**
   * True when the projection tables were actually replaced from a snapshot
   * still current at commit time. False when every attempt lost the
   * compare-and-swap below and NOTHING was written — the projection still
   * shows whatever the winning writer left, and the events this call read are
   * in the log, waiting for the next rebuild that completes.
   *
   * Widened from `void` (#270) rather than throwing: see
   * {@link REBUILD_STALE_HEAD_RETRIES}. Callers that ignore the result keep
   * the pre-#270 behavior, which is what all five of them do today.
   */
  committed: boolean;
}

/**
 * Extra attempts {@link rebuildProjectProjection} spends re-reading the log
 * after losing the snapshot compare-and-swap (#270). Two, matching
 * `memory-import-service`'s `IMPORT_STALE_HEAD_RETRIES` and for the same
 * reason: each retry costs one full log replay, and a store contended enough
 * to lose three in a row has a problem a fourth replay will not solve.
 *
 * Why exhaustion RETURNS (`committed: false`) instead of throwing. This
 * function is `await`ed on `captureObservation`'s hot path and in three
 * post-append tails (`consolidate`, `importMemories`, `detectContradictions`);
 * in all four the events are already durable when the rebuild runs. Throwing
 * would convert a lost race — whose loser is by construction the writer whose
 * snapshot is the OLDER one — into a caller-visible failure of work that
 * actually succeeded, which is exactly the "quietly turning a real failure
 * into a wrong-looking success" trap `importMemories` documents at its own
 * retry loop (it deliberately retries only BEFORE its append for that reason).
 * And the loss is self-healing rather than silent: the writer that won the CAS
 * appended, and every append path in the kernel rebuilds after appending, so
 * its rebuild reads a log that contains this call's events too.
 */
const REBUILD_STALE_HEAD_RETRIES = 2;

/**
 * Recompute the full projection from the event log and replace every
 * projection table in a SINGLE transaction (replace-all semantics).
 * reduceProjectState is the single reduction authority; this function is only
 * the persistence sink. Topic `.md` files are written outside the transaction
 * (they are filesystem content, not table rows).
 *
 * #270 (#263 candidate ①, #189 residue): the replace-all is now conditional on
 * the log not having moved under it. The snapshot the tables are computed from
 * is certified by the head of THAT VERY READ, and the write transaction
 * re-checks that head, inside itself, before deleting anything — so a rebuild
 * that slept through a successor's whole boundary no longer overwrites the
 * successor's projection with its own older state (`storage/project-lock.ts`,
 * "The lock-free replace-all"). What it does NOT give is freshness for the
 * READER: this bounds how stale a committed rebuild can be, not how stale the
 * projection a consumer reads is (#263 axis 1, still open on #189).
 */
export async function rebuildProjectProjection(
  projectId: string,
  opts: RebuildProjectProjectionOptions = {},
): Promise<RebuildProjectProjectionResult> {
  const reindexSearch = opts.reindexSearch ?? true;
  for (let attempt = 0; ; attempt += 1) {
    // Nothing is written on a lost attempt (the CAS sits before the first
    // DELETE, inside the transaction), so re-reading the log and recomputing
    // is a clean retry, not a partial redo.
    if (await attemptProjectionRebuild(projectId, reindexSearch)) return { committed: true };
    if (attempt >= REBUILD_STALE_HEAD_RETRIES) {
      process.stderr.write(`WARN: projection rebuild deferred (${projectId}, log kept moving)\n`);
      return { committed: false };
    }
  }
}

/**
 * One attempt of the replace-all: read the log, compute every table, and
 * commit only if the head is still the one the read saw. Returns false when
 * the head moved (nothing written at all), true when the projection was
 * replaced.
 */
async function attemptProjectionRebuild(
  projectId: string,
  reindexSearch: boolean,
): Promise<boolean> {
  // #270: the snapshot AND the token certifying it come from one array — the
  // head of this very read, never a second head query against the store, which
  // would open a fresh ordering window between the two. Same shape as
  // `memory-import-service`'s `readValidMemoriesFromLog` (#253) and the dedup
  // snapshot in #262.
  const events = await readEvents(projectId);
  const snapshotHead = events.at(-1)?.id ?? null;
  // Pass the store's own id as the authoritative self identity so a workspace
  // union (multiple members' project.created) reduces without mis-anchoring self
  // by seq order or throwing on a foreign genesis (SoT-021/022).
  const state = reduceProjectState(events, projectId);
  if (!state.project) {
    throw new Error(`Project ${projectId} has no project.created event`);
  }
  const project = state.project;

  const importedRules = latestImportedRules(state.rules);

  const baseMemoryIndex = buildMemoryIndex(state);
  const memoryIndex: PersistedMemoryIndex = {
    ...baseMemoryIndex,
    mustReadTopics: importedRules.map((rule) => ({
      id: rule.id,
      title: rule.title,
      path: getTopicFile(projectId, rule.id),
    })),
  };

  // Topic content lives in `.md` files on disk (written below, outside the
  // tx). Read the previously-persisted topic content here, BEFORE opening the
  // synchronous rebuild transaction, so the FTS rows can be inserted inline.
  // A missing file (e.g. first rebuild after an import) is skipped — the rule
  // body is still indexed via the file write at the end of the prior rebuild.
  // When reindexSearch is false the FTS rows are left untouched, so the
  // (async, disk-reading) topic content load is skipped entirely.
  const topicSearchRows = reindexSearch
    ? (
        await Promise.all(
          importedRules.map(async (rule) => {
            const content = await readJson<{ title?: string; body?: string }>(
              getTopicFile(projectId, rule.id),
            );
            const text = searchText([rule.title, content?.title, content?.body ?? rule.body]);
            return text ? { entityId: rule.id, text } : undefined;
          }),
        )
      ).filter((row): row is { entityId: string; text: string } => row !== undefined)
    : [];

  const db = getDb(projectId);
  let committed = false;
  const writeAll = db.transaction(() => {
    // #270 compare-and-swap. Every table below is replaced from `events`, a
    // snapshot taken before this function's awaits; if the log has moved since,
    // that snapshot is missing another writer's appends and writing it would
    // ERASE their projection rows (the successor's memories vanish while the
    // log still has them — `storage/project-lock.ts`'s T1–T6). Refusing here
    // costs one recompute; committing costs the other writer's state.
    //
    // Inside the transaction, not before it, and the transaction is IMMEDIATE
    // (below) — the same reasoning `consolidate-service.ts`'s
    // `commitBoundaryCursors` and `embeddings-service.ts`'s
    // `upsertSegmentEmbeddingIfLive` already spell out: the value read is one
    // ANOTHER PROCESS writes, so the read and the write it gates must not be
    // separable. A deferred BEGIN takes its write lock only at the first
    // DELETE, which leaves this compare reading a snapshot a competing writer
    // can append over before the wipe lands — the guard would then pass on
    // exactly the stale basis it exists to reject.
    if ((headEventId(db) ?? null) !== snapshotHead) return;
    // Retrieval reinforcement (`last_accessed_at`, `injection_count`) is NOT
    // wiped and re-derived here: it lives in `memory_access` (v17, #235),
    // which is absent from the two table lists below on purpose, so the
    // DELETE loop never reaches it. Nothing to carry over — see the v17
    // comment in storage/db.ts for why carrying it over was the defect.
    for (const table of [...SINGLETON_TABLES, ...ENTITY_TABLES]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    // search_fts is a replace-all sink too — wipe then repopulate within the
    // same tx (per-project db, so the unqualified DELETE is correct). When
    // reindexSearch is false we skip the wipe AND every indexEntity call, so
    // the existing FTS rows survive untouched while the projection tables
    // above (unconditional, from the same full-log replay) are still fully
    // rebuilt. That divergence is only safe under the invariant spelled out
    // on `RebuildProjectProjectionOptions.reindexSearch` above (#277): today
    // nothing that can create or modify a searchable entity — via a log
    // append OR a direct table write (e.g. segments) — runs with
    // reindexSearch:false or outside this project's lock while a
    // reindexSearch:false rebuild is in flight, EXCEPT the pre-existing,
    // separately-tracked lock-dispossession race documented on
    // project-lock.ts's "The overlap that remains" (not evaluated further
    // here — see the option doc above).
    if (reindexSearch) {
      db.prepare("DELETE FROM search_fts").run();
    }
    const insertSearch = db.prepare(
      "INSERT INTO search_fts (entity_id, kind, source_project_id, text) " +
        "VALUES (@entityId, @kind, @sourceProjectId, @text)",
    );
    const indexEntity = (
      entityId: string,
      kind: SearchKind,
      text: string,
      sourceProjectId: string | null = null,
    ) => {
      if (reindexSearch && text) insertSearch.run({ entityId, kind, sourceProjectId, text });
    };

    db.prepare("INSERT INTO projects (id, data) VALUES (?, ?)").run(
      project.id,
      JSON.stringify(project),
    );
    db.prepare("INSERT INTO memory_index (id, data) VALUES (?, ?)").run(
      project.id,
      JSON.stringify(memoryIndex),
    );

    const insertWorkstream = db.prepare(
      "INSERT INTO workstreams (id, status, data) VALUES (@id, @status, @data)",
    );
    for (const workstream of Object.values(state.workstreams)) {
      insertWorkstream.run({
        id: workstream.id,
        status: workstream.status ?? null,
        data: JSON.stringify(workstream),
      });
    }

    const insertTask = db.prepare(
      `INSERT INTO tasks (id, status, workstream_id, created_at, updated_at, source_project_id, data)
       VALUES (@id, @status, @workstreamId, @createdAt, @updatedAt, @sourceProjectId, @data)`,
    );
    for (const [key, task] of Object.entries(state.tasks)) {
      const sourceProjectId = laneColumn(key);
      insertTask.run({
        id: task.id,
        status: task.status ?? null,
        workstreamId: task.workstreamId ?? null,
        createdAt: task.createdAt ?? null,
        updatedAt: task.updatedAt ?? null,
        sourceProjectId,
        data: JSON.stringify(task),
      });
      indexEntity(
        task.id,
        "task",
        searchText([
          task.title,
          task.description,
          task.goal,
          ...(task.acceptanceCriteria ?? []),
          ...(task.openQuestions ?? []),
        ]),
        sourceProjectId,
      );
    }

    const insertTaskRequest = db.prepare(
      `INSERT INTO task_requests (id, status, target_project_id, source_project_id, created_at, data)
       VALUES (@id, @status, @targetProjectId, @sourceProjectId, @createdAt, @data)`,
    );
    for (const [key, request] of Object.entries(state.taskRequests)) {
      insertTaskRequest.run({
        id: request.id,
        status: request.status,
        targetProjectId: request.targetProjectId,
        sourceProjectId: laneColumn(key),
        createdAt: request.createdAt ?? null,
        data: JSON.stringify(request),
      });
    }

    const insertHandoff = db.prepare(
      "INSERT INTO handoffs (id, source_project_id, data) VALUES (@id, @sourceProjectId, @data)",
    );
    for (const [key, handoff] of Object.entries(state.handoffs)) {
      const sourceProjectId = laneColumn(key);
      insertHandoff.run({
        id: handoff.id,
        sourceProjectId,
        data: JSON.stringify(handoff),
      });
      indexEntity(
        handoff.id,
        "handoff",
        searchText([
          handoff.summary,
          handoff.nextAction,
          ...(handoff.doneItems ?? []),
          ...(handoff.remainingItems ?? []),
          ...(handoff.warnings ?? []),
          ...(handoff.unresolvedQuestions ?? []),
        ]),
        sourceProjectId,
      );
    }

    const insertCheckpoint = db.prepare("INSERT INTO checkpoints (id, data) VALUES (@id, @data)");
    for (const checkpoint of Object.values(state.checkpoints)) {
      insertCheckpoint.run({
        id: checkpoint.id,
        data: JSON.stringify(checkpoint),
      });
      indexEntity(
        checkpoint.id,
        "checkpoint",
        searchText([
          checkpoint.summary,
          ...(checkpoint.taskUpdates ?? []),
          ...(checkpoint.projectUpdates ?? []),
          ...(checkpoint.deferredItems ?? []),
        ]),
      );
    }

    const insertDecision = db.prepare(
      "INSERT INTO decisions (id, status, data) VALUES (@id, @status, @data)",
    );
    for (const decision of Object.values(state.decisions)) {
      insertDecision.run({
        id: decision.id,
        status: decision.status ?? null,
        data: JSON.stringify(decision),
      });
      indexEntity(
        decision.id,
        "decision",
        searchText([decision.title, decision.decision, decision.rationale]),
      );
    }

    const insertRule = db.prepare(
      "INSERT INTO rules (id, source, data) VALUES (@id, @source, @data)",
    );
    for (const rule of Object.values(state.rules)) {
      insertRule.run({
        id: rule.id,
        source: rule.source ?? null,
        data: JSON.stringify(rule),
      });
    }

    const insertConflict = db.prepare(
      "INSERT INTO conflicts (id, status, data) VALUES (@id, @status, @data)",
    );
    for (const conflict of Object.values(state.conflicts)) {
      insertConflict.run({
        id: conflict.id,
        status: conflict.status ?? null,
        data: JSON.stringify(conflict),
      });
    }

    const insertSession = db.prepare(
      "INSERT INTO sessions (id, status, source_project_id, data) " +
        "VALUES (@id, @status, @sourceProjectId, @data)",
    );
    for (const [key, session] of Object.entries(state.sessions)) {
      insertSession.run({
        id: session.id,
        status: session.status ?? null,
        sourceProjectId: laneColumn(key),
        data: JSON.stringify(session),
      });
    }

    const insertObservation = db.prepare(
      `INSERT INTO observations (id, session_id, signal, created_at, source_project_id, data)
       VALUES (@id, @sessionId, @signal, @createdAt, @sourceProjectId, @data)`,
    );
    for (const observation of Object.values(state.observations)) {
      insertObservation.run({
        id: observation.id,
        sessionId: observation.sessionId ?? null,
        signal: observation.signal,
        createdAt: observation.createdAt,
        sourceProjectId: observation.sourceProjectId ?? null,
        data: JSON.stringify(observation),
      });
    }

    const insertMemory = db.prepare(
      `INSERT INTO memories
         (id, kind, salience, created_at, invalid_at, superseded_by,
          deduped_by, source_project_id, data)
       VALUES
         (@id, @kind, @salience, @createdAt, @invalidAt, @supersededBy,
          @dedupedBy, @sourceProjectId, @data)`,
    );
    for (const memory of Object.values(state.memories)) {
      // Memories are id-keyed (unique ids); the lane rides on the record itself.
      const sourceProjectId = memory.sourceProjectId ?? null;
      insertMemory.run({
        id: memory.id,
        kind: memory.kind,
        salience: memory.salience,
        createdAt: memory.createdAt,
        invalidAt: memory.invalidAt ?? null,
        supersededBy: memory.supersededBy ?? null,
        dedupedBy: memory.dedupedBy ?? null,
        sourceProjectId,
        data: JSON.stringify(memory),
      });
      // Superseded memories stay indexed — "what was true then" remains
      // findable; retrieval-time ranking is what filters to valid-only. Dedup
      // losers are NOT indexed: unlike a contradiction, a cross-machine
      // duplicate has no distinct "then" to recover, and keeping it out of FTS
      // means searchProject converges to the single winner too. Retracted
      // memories are likewise dropped from FTS (M3, SoT-050): a retraction is a
      // deliberate "make it go away", stronger than a bi-temporal supersede, so
      // even raw searchProject (which has no valid-only filter) must not surface
      // it. The row + event survive for audit and reversibility.
      if (!memory.dedupedBy && !memory.retractedAt) {
        indexEntity(memory.id, "memory", searchText([memory.text]), sourceProjectId);
      }
    }

    for (const topic of topicSearchRows) {
      indexEntity(topic.entityId, "topic", topic.text);
    }

    // Raw transcript segments (v10) live in a DERIVED table the projector does
    // not know about, so the FTS wipe above would drop their rows. Re-emit them
    // from the segments table on every reindex (same pattern as topicSearchRows
    // reading external .md content). Empty table => zero rows => byte-identical.
    // Explicit "union": this is the one legitimate full-corpus read (#72) — the
    // FTS reindex mirrors source_project_id onto search_fts itself, so a
    // foreign segment still resolves through laneWhere at query time. Every
    // OTHER listSegments/listSegmentTexts call site must stay self-only.
    for (const seg of listSegments(projectId, "union")) {
      indexEntity(seg.id, "segment", seg.text, seg.sourceProjectId ?? null);
    }
    committed = true;
  });
  writeAll.immediate();
  // Nothing was written — including the topic `.md` files below, which are
  // derived from the same rejected snapshot and would push its (stale) rule
  // bodies onto disk where no transaction can take them back.
  if (!committed) return false;

  // Topic content files: imported rules become readable `.md` topics that the
  // memory index points at via mustReadTopics[].path. These are content
  // artifacts on disk, not a projection table.
  await Promise.all(
    Object.values(state.rules)
      .filter((rule) => rule.source === "imported")
      .map((rule) =>
        writeJson(getTopicFile(projectId, rule.id), {
          title: rule.title,
          body: rule.body,
          sourceRuleId: rule.id,
        }),
      ),
  );
  return true;
}

// --- read side -------------------------------------------------------------

function parse<T>(row: { data: string } | undefined): T | undefined {
  return row ? (JSON.parse(row.data) as T) : undefined;
}

function parseAll<T>(rows: Array<{ data: string }>): T[] {
  return rows.map((row) => JSON.parse(row.data) as T);
}

function db(projectId: string): Database.Database {
  return getDb(projectId);
}

export function getProjectProjection(projectId: string): Project | undefined {
  const row = db(projectId).prepare("SELECT data FROM projects WHERE id = ?").get(projectId) as
    { data: string } | undefined;
  return parse<Project>(row);
}

/**
 * State-as-of-revision: reduce the event log up to and including `upToEventId`.
 * Read-only — no projection tables are written. Reuses the single reduction
 * authority `reduceProjectState`, exactly like `rebuildProjectProjection`.
 */
export async function getProjectStateAtRevision(
  projectId: string,
  upToEventId: string,
): Promise<ProjectState> {
  return reduceProjectState(await readEventsUpTo(projectId, upToEventId), projectId);
}

export function getMemoryIndex(projectId: string): PersistedMemoryIndex | undefined {
  const row = db(projectId).prepare("SELECT data FROM memory_index WHERE id = ?").get(projectId) as
    { data: string } | undefined;
  return parse<PersistedMemoryIndex>(row);
}

export function getWorkstream(projectId: string, workstreamId: string): Workstream | undefined {
  const row = db(projectId)
    .prepare("SELECT data FROM workstreams WHERE id = ?")
    .get(workstreamId) as { data: string } | undefined;
  return parse<Workstream>(row);
}

export function getTask(projectId: string, taskId: string): Task | undefined {
  const row = db(projectId).prepare("SELECT data FROM tasks WHERE id = ?").get(taskId) as
    { data: string } | undefined;
  return parse<Task>(row);
}

export interface ListTasksFilters {
  status?: Task["status"];
  workstreamId?: string;
}

export function listTasks(
  projectId: string,
  filters: ListTasksFilters = {},
  lane: ProjectionLane = "self",
): Task[] {
  // laneWhere is always present, so the WHERE is unconditional; self-lane
  // (default) keeps a single-writer store's list byte-identical to pre-M2.
  const clauses: string[] = [laneWhere(lane)];
  const params: unknown[] = [];
  if (filters.status) {
    clauses.push("status = ?");
    params.push(filters.status);
  }
  if (filters.workstreamId) {
    clauses.push("workstream_id = ?");
    params.push(filters.workstreamId);
  }
  const where = ` WHERE ${clauses.join(" AND ")}`;
  const rows = db(projectId)
    .prepare(`SELECT data FROM tasks${where} ORDER BY created_at ASC`)
    .all(...params) as Array<{ data: string }>;
  return parseAll<Task>(rows);
}

export async function getTaskRequest(
  projectId: string,
  requestId: string,
): Promise<TaskRequest | undefined> {
  const row = db(projectId)
    .prepare("SELECT data FROM task_requests WHERE id = ?")
    .get(requestId) as { data: string } | undefined;
  return parse<TaskRequest>(row);
}

export interface ListTaskRequestsFilters {
  direction?: "inbound" | "outbound";
  status?: TaskRequestStatus;
}

/**
 * SoT-041 addressing is a union filter, not routing: inbound = any lane's
 * request addressed to THIS store; outbound = the self lane's own requests
 * (self-targeting is rejected at creation, so the two sets are disjoint).
 */
export async function listTaskRequests(
  projectId: string,
  filters: ListTaskRequestsFilters = {},
): Promise<TaskRequest[]> {
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  if (filters.direction === "inbound") {
    clauses.push("target_project_id = @self");
    params.self = projectId;
  } else if (filters.direction === "outbound") {
    clauses.push("source_project_id IS NULL");
  }
  if (filters.status) {
    clauses.push("status = @status");
    params.status = filters.status;
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = db(projectId)
    .prepare(`SELECT data FROM task_requests${where} ORDER BY created_at ASC`)
    .all(params) as Array<{ data: string }>;
  return parseAll<TaskRequest>(rows);
}

export function getHandoff(projectId: string, handoffId: string): Handoff | undefined {
  const row = db(projectId).prepare("SELECT data FROM handoffs WHERE id = ?").get(handoffId) as
    { data: string } | undefined;
  return parse<Handoff>(row);
}

export function getCheckpoint(projectId: string, checkpointId: string): Checkpoint | undefined {
  const row = db(projectId)
    .prepare("SELECT data FROM checkpoints WHERE id = ?")
    .get(checkpointId) as { data: string } | undefined;
  return parse<Checkpoint>(row);
}

export function getRule(projectId: string, ruleId: string): Rule | undefined {
  const row = db(projectId).prepare("SELECT data FROM rules WHERE id = ?").get(ruleId) as
    { data: string } | undefined;
  return parse<Rule>(row);
}

/**
 * Returns ALL imported rules for a project (all historical duplicates
 * included). The event log / rules table is append-only; this is the raw
 * view. Use mustReadTopics from getMemoryIndex() for the deduplicated view.
 */
export function listImportedRules(projectId: string): Rule[] {
  const rows = db(projectId)
    .prepare("SELECT data FROM rules WHERE source = 'imported'")
    .all() as Array<{ data: string }>;
  return parseAll<Rule>(rows);
}

export function getDecision(projectId: string, decisionId: string): Decision | undefined {
  const row = db(projectId).prepare("SELECT data FROM decisions WHERE id = ?").get(decisionId) as
    { data: string } | undefined;
  return parse<Decision>(row);
}

/**
 * List a project's decisions, newest first. By default returns only the live
 * (accepted) set — the same decisions `acceptedDecisionIds` carries; pass
 * `includeSuperseded` to also surface the preserved superseded ones. Pure
 * read of the projection, mirroring `listOpenConflicts`.
 */
export function listDecisions(
  projectId: string,
  opts: { includeSuperseded?: boolean } = {},
): Decision[] {
  const where = opts.includeSuperseded ? "" : " WHERE status = 'accepted'";
  const rows = db(projectId).prepare(`SELECT data FROM decisions${where}`).all() as Array<{
    data: string;
  }>;
  return parseAll<Decision>(rows).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getConflict(projectId: string, conflictId: string): Conflict | undefined {
  const row = db(projectId).prepare("SELECT data FROM conflicts WHERE id = ?").get(conflictId) as
    { data: string } | undefined;
  return parse<Conflict>(row);
}

/**
 * Open = not in a terminal status. `TERMINAL_CONFLICT_STATUSES` (derived from
 * `conflictTransitions`, the state machine) currently covers `resolved` AND
 * `auto_resolved` — both have no outgoing transition, so a conflict the
 * pipeline auto-resolved must stop showing up here just like an explicitly
 * resolved one (#118 item 2). `escalated` still transitions to `resolved`, so
 * it stays open.
 */
export function listOpenConflicts(projectId: string): Conflict[] {
  const placeholders = TERMINAL_CONFLICT_STATUSES.map(() => "?").join(", ");
  const rows = db(projectId)
    .prepare(`SELECT data FROM conflicts WHERE status NOT IN (${placeholders})`)
    .all(...TERMINAL_CONFLICT_STATUSES) as Array<{ data: string }>;
  return parseAll<Conflict>(rows);
}

export function listSessions(projectId: string, lane: ProjectionLane = "self"): Session[] {
  const rows = db(projectId)
    .prepare(`SELECT data FROM sessions WHERE ${laneWhere(lane)}`)
    .all() as Array<{ data: string }>;
  return parseAll<Session>(rows);
}

export function getSession(projectId: string, sessionId: string): Session | undefined {
  const row = db(projectId).prepare("SELECT data FROM sessions WHERE id = ?").get(sessionId) as
    { data: string } | undefined;
  return parse<Session>(row);
}

// --- CLS two-layer memory (Phase 1) -----------------------------------------

/** A valid (non-superseded) memory plus its reinforcement stamp, if any. */
export interface ValidMemoryRow {
  memory: MemoryRecord;
  /**
   * Projection-only reinforcement signal (`memory_access`, v17). Absent until
   * the memory has actually been injected once — never reinforced is the
   * normal state, not a degraded one.
   */
  lastAccessedAt?: string;
}

/**
 * LEFT JOIN, never INNER: `memory_access` holds a row only for memories that
 * have been injected at least once, so an inner join would drop every
 * never-reinforced memory from retrieval — i.e. most of them on a young store.
 */
const MEMORY_ACCESS_JOIN =
  "FROM memories LEFT JOIN memory_access ON memory_access.memory_id = memories.id";

/**
 * Read a single memory by id (valid or already-superseded), with its
 * reinforcement stamp. Mirrors the single-entity readers (getTask/getRule) but
 * carries `lastAccessedAt` like listValidMemories so `memory show` can surface
 * the reinforcement signal. Returns undefined when no memory with that id
 * exists in the project.
 */
export function getMemory(projectId: string, memoryId: string): ValidMemoryRow | undefined {
  const row = db(projectId)
    .prepare(
      `SELECT memories.data AS data, memory_access.last_accessed_at AS last_accessed_at ` +
        `${MEMORY_ACCESS_JOIN} WHERE memories.id = ?`,
    )
    .get(memoryId) as { data: string; last_accessed_at: string | null } | undefined;
  if (!row) return undefined;
  return {
    memory: JSON.parse(row.data) as MemoryRecord,
    ...(row.last_accessed_at ? { lastAccessedAt: row.last_accessed_at } : {}),
  };
}

/**
 * Memories whose validity window is still open, i.e. not superseded. Self-lane
 * by default (the local project's own memories, injected as local truth); a
 * `union` read surfaces every writer's memories for the labelled shared channel
 * (W3), which must NOT be folded into local truth (SoT-010/040).
 */
export function listValidMemories(
  projectId: string,
  lane: ProjectionLane = "self",
): ValidMemoryRow[] {
  const rows = db(projectId)
    .prepare(
      `SELECT memories.data AS data, memory_access.last_accessed_at AS last_accessed_at ` +
        `${MEMORY_ACCESS_JOIN} ` +
        // `laneWhere` names a bare `source_project_id`; only `memories` has one,
        // so it stays unambiguous across the join.
        `WHERE memories.invalid_at IS NULL AND ${laneWhere(lane)}`,
    )
    .all() as Array<{ data: string; last_accessed_at: string | null }>;
  return rows.map((row) => ({
    memory: JSON.parse(row.data) as MemoryRecord,
    ...(row.last_accessed_at ? { lastAccessedAt: row.last_accessed_at } : {}),
  }));
}

/**
 * Most recent observations (short-term tail), newest first. Old rows are
 * never deleted (append-only all the way down) — readers just take a recent
 * window. Self-lane by default (#74) — a foreign union writer's observations
 * must not silently join the local short-term tail (SoT-040); `union` admits
 * every writer's rows for a labelled shared channel.
 */
export function listRecentObservations(
  projectId: string,
  opts: { sessionId?: string; limit: number; sinceIso?: string; lane?: ProjectionLane },
): ObservationRecord[] {
  const clauses: string[] = [laneWhere(opts.lane ?? "self")];
  const params: unknown[] = [];
  if (opts.sessionId) {
    clauses.push("session_id = ?");
    params.push(opts.sessionId);
  }
  if (opts.sinceIso) {
    clauses.push("created_at >= ?");
    params.push(opts.sinceIso);
  }
  const where = ` WHERE ${clauses.join(" AND ")}`;
  const rows = db(projectId)
    .prepare(`SELECT data FROM observations${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, opts.limit) as Array<{ data: string }>;
  return parseAll<ObservationRecord>(rows);
}

/**
 * Retrieval reinforcement: stamp `last_accessed_at` on the memories that were
 * just injected into a session. Projection-level write on the DERIVED
 * `memory_access` table (v17, #235) — the events log is untouched, so the
 * append-only invariant holds.
 *
 * The upsert is ONE statement per id, so the counter bump is atomic even
 * though this runs outside the project lock (`transformContext` cannot take
 * one). `rebuildProjectProjection` no longer touches this table at all, so
 * neither a routine rebuild nor a from-scratch replay can revert what is
 * written here.
 */
export function touchMemoryAccess(
  projectId: string,
  memoryIds: string[],
  accessedAtIso: string,
): void {
  if (memoryIds.length === 0) return;
  const database = db(projectId);
  // #62 — startup injection is also an injection: bump the telemetry counter
  // in the same statement as the reinforcement stamp.
  const upsert = database.prepare(
    "INSERT INTO memory_access (memory_id, last_accessed_at, injection_count) " +
      "VALUES (?, ?, 1) " +
      "ON CONFLICT(memory_id) DO UPDATE SET " +
      "last_accessed_at = excluded.last_accessed_at, " +
      "injection_count = memory_access.injection_count + 1",
  );
  database.transaction(() => {
    for (const memoryId of memoryIds) {
      upsert.run(memoryId, accessedAtIso);
    }
  })();
}

/**
 * #62 behavioral telemetry — count a mid-session live-share injection of a
 * memory. UNLIKE touchMemoryAccess this deliberately does NOT stamp
 * `last_accessed_at`: reinforcement feeds retrieval ranking, and the #62
 * contract is observe-only (no behavior change to injection/ranking). Hence
 * the upsert names only `injection_count` — an inserted row leaves
 * `last_accessed_at` at its NULL default, and an existing row keeps whatever
 * stamp it already had.
 */
export function bumpMemoryInjections(projectId: string, memoryIds: string[]): void {
  if (memoryIds.length === 0) return;
  const database = db(projectId);
  const upsert = database.prepare(
    "INSERT INTO memory_access (memory_id, injection_count) VALUES (?, 1) " +
      "ON CONFLICT(memory_id) DO UPDATE SET " +
      "injection_count = memory_access.injection_count + 1",
  );
  database.transaction(() => {
    for (const memoryId of memoryIds) {
      upsert.run(memoryId);
    }
  })();
}

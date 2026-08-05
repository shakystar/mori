import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import { createId, CURRENT_SCHEMA_VERSION, nowIso } from "../domain/common.js";
import type { DomainEvent, DomainEventPayload, DomainEventType } from "../domain/events.js";
import { MemorizeError } from "../shared/errors.js";
import { getDb } from "./db.js";
import { ensureDir } from "./fs-utils.js";
import { getProjectDbFile, getProjectRoot } from "./path-resolver.js";

export interface AppendEventInput<TPayload extends DomainEventPayload> {
  type: DomainEventType;
  projectId: string;
  scopeType: DomainEvent["scopeType"];
  scopeId: string;
  actor: string;
  /**
   * Optional provenance overrides (Phase 0). Omitted in the normal local-append
   * path, where `writer` defaults to `actor` and `sourceProjectId` to
   * `projectId` — so existing callers need no change. Set explicitly only when
   * the event's origin differs from the local actor/store.
   */
  writer?: string;
  sourceProjectId?: string;
  payload: TPayload;
}

export async function ensureProjectDirectories(projectId: string): Promise<void> {
  const projectRoot = getProjectRoot(projectId);
  // Events and the entity projections (tasks, workstreams, rules, …) live in
  // SQLite, so their old JSON dirs are not created here. Only the dirs still
  // written to disk remain: `topics/` (topic `.md` files) and `sync/` (remote
  // sync state).
  await Promise.all(
    [projectRoot, path.join(projectRoot, "topics"), path.join(projectRoot, "sync")].map((dirPath) =>
      ensureDir(dirPath),
    ),
  );
}

/**
 * True when this project's store has already been created on disk (the db file exists).
 * A plain `fs.existsSync` check — deliberately not `getDb`/`hasGenesisEvent`, both of which
 * open (and on a missing file, create) the database as a side effect. A caller that wants to
 * know "has anything ever happened here" without risking being the first thing that happens
 * needs a check with zero side effects (#107 review: a read-only session must leave no trace).
 */
export function projectStoreExists(projectId: string): boolean {
  return fs.existsSync(getProjectDbFile(projectId));
}

/**
 * Earliest `created_at` in the log, or undefined if the log is empty. Genesis
 * backfill uses this to date a reconstructed `project.created` at the store's
 * true start (its first captured event) rather than at repair time.
 */
export function getEarliestEventCreatedAt(projectId: string): string | undefined {
  const row = getDb(projectId).prepare("SELECT MIN(created_at) AS t FROM events").get() as
    { t: string | null } | undefined;
  return row?.t ?? undefined;
}

/**
 * True when the log already holds a self-scoped `project.created` genesis for
 * this project. Genesis backfill uses this to distinguish "no genesis, recover
 * by synthesizing one" from "genesis present but projection unbuilt, recover by
 * rebuilding" — the latter must NOT append a second same-id genesis, whose
 * reconstructed defaults would win over the real metadata under later-wins.
 */
export function hasGenesisEvent(projectId: string): boolean {
  const row = getDb(projectId)
    .prepare(
      `SELECT 1 FROM events
        WHERE type = 'project.created' AND project_id = ?
        LIMIT 1`,
    )
    .get(projectId) as { 1: number } | undefined;
  return row !== undefined;
}

/**
 * True when `error` is the `idx_events_genesis_once` unique-index violation
 * (db.ts v18, #236 / #189 B) — this store already has a `project.created`
 * row and this insert just lost the race to mint a second one. `ensureGenesis`
 * (kernel/sqlite-memory-kernel.ts) treats this as "another process already
 * bootstrapped the store," the normal outcome of losing that race, not a
 * failure — `hasGenesisEvent`'s own check-then-append gap (#132's lock does
 * not close it once a critical section is entered, only reports the loss
 * afterward) is exactly the window this index exists to backstop.
 *
 * SQLite's constraint-violation message names the INDEXED COLUMNS
 * (`events.project_id`), not the index itself — better-sqlite3 does not
 * surface the index name on the error at all, so that column list is the
 * only thing available to match on. `project_id` alone is not indexed
 * uniquely anywhere else in this schema (`events.id`'s own v1 UNIQUE is a
 * separate column), so the message is unambiguous.
 */
export function isDuplicateGenesisError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "SQLITE_CONSTRAINT_UNIQUE" &&
    /UNIQUE constraint failed: events\.project_id/.test(error.message)
  );
}

/**
 * A batch refused because the log had moved since the caller read the basis it
 * judged on (#253 / #189 A). Carries the two ids rather than only a message so
 * a caller that retries can tell how far it fell behind; NOT the batch or its
 * payloads — a rejection is logged and surfaced by callers, and event ids are
 * opaque while payloads are memory text.
 */
export class StaleHeadError extends MemorizeError {
  /** What the caller believed the head was; `null` = "the log was empty". */
  readonly expectedHead: string | null;
  /** What the head actually was, read inside the append transaction. */
  readonly actualHead: string | null;

  constructor(projectId: string, expectedHead: string | null, actualHead: string | null) {
    super(
      `Append to project ${projectId} rejected: expected log head ` +
        `${expectedHead ?? "(empty log)"}, found ${actualHead ?? "(empty log)"}.`,
    );
    this.name = "StaleHeadError";
    this.expectedHead = expectedHead;
    this.actualHead = actualHead;
  }
}

/**
 * True when `error` is {@link appendEvents}' compare-and-append rejection —
 * "you lost the race", as opposed to a real failure. Same role
 * `isDuplicateGenesisError` plays for B (#236): a caller must be able to
 * narrow the one outcome it knows how to recover from and let everything else
 * propagate untouched.
 *
 * Matches on the observable `name`, not `instanceof`. The kernel ships both a
 * `src` (tests, `tsx`) and a `dist` (`@mori/kernel` consumers) copy of this
 * module, and a process that loads both gets two distinct class objects —
 * `instanceof` then returns false for an error raised through the other copy,
 * silently reclassifying a lost race as a hard failure. `name` is set in the
 * constructor above and survives that split.
 */
export function isStaleHeadError(error: unknown): error is StaleHeadError {
  return error instanceof Error && error.name === "StaleHeadError";
}

/** The newest event's id on an ALREADY-RESOLVED connection, or undefined for an
 *  empty log. Shared by `readHeadEventId` (the public probe) and
 *  `appendEvents`' compare-and-append check, which needs the same question
 *  answered on the connection whose transaction it is already inside — going
 *  back through `getDb` there would be the same connection anyway, but taking
 *  it as an argument is what makes "this read is inside the transaction"
 *  visible at the call site rather than incidental.
 *
 *  Exported (#270) for the same reason from OUTSIDE this module:
 *  `rebuildProjectProjection`'s replace-all re-checks the head inside its own
 *  IMMEDIATE transaction, and `readHeadEventId` — async, and resolving the
 *  connection itself — cannot be called from a better-sqlite3 transaction
 *  callback at all. Taking the `db` keeps that call site honest about which
 *  connection (and therefore which transaction) the read happens on. */
export function headEventId(db: Database.Database): string | undefined {
  const row = db.prepare("SELECT id FROM events ORDER BY seq DESC LIMIT 1").get() as
    { id: string } | undefined;
  return row?.id;
}

/** Map a DomainEvent onto the `events` table columns. payload is JSON text. */
function insertEvent(db: Database.Database, event: DomainEvent): void {
  db.prepare(
    `INSERT INTO events
       (id, schema_version, created_at, updated_at, type,
        project_id, scope_type, scope_id, actor,
        writer, source_project_id, payload)
     VALUES
       (@id, @schemaVersion, @createdAt, @updatedAt, @type,
        @projectId, @scopeType, @scopeId, @actor,
        @writer, @sourceProjectId, @payload)`,
  ).run({
    id: event.id,
    schemaVersion: event.schemaVersion,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    type: event.type,
    projectId: event.projectId,
    scopeType: event.scopeType,
    scopeId: event.scopeId,
    actor: event.actor,
    writer: event.writer ?? null,
    sourceProjectId: event.sourceProjectId ?? null,
    payload: JSON.stringify(event.payload),
  });
}

export async function appendEvent<TPayload extends DomainEventPayload>(
  input: AppendEventInput<TPayload>,
): Promise<DomainEvent<TPayload>> {
  const timestamp = nowIso();
  const event: DomainEvent<TPayload> = {
    id: createId("evt"),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    type: input.type,
    projectId: input.projectId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    actor: input.actor,
    // Phase 0 provenance: default writer to the local actor, source to the local
    // store. Unchanged callers leave input.writer/input.sourceProjectId unset.
    writer: input.writer ?? input.actor,
    sourceProjectId: input.sourceProjectId ?? input.projectId,
    payload: input.payload,
  };

  // better-sqlite3 is synchronous; the async signature is preserved so
  // existing `await appendEvent(...)` call sites stay unchanged.
  insertEvent(getDb(input.projectId), event);
  return event;
}

export interface AppendEventsOptions {
  /**
   * Compare-and-append (#253 / #189 A): the id the caller observed as the
   * log's HEAD at the moment it read the basis it is about to write a verdict
   * on. `null` means "the log was empty then". The append is refused with
   * {@link StaleHeadError} unless the head is still exactly that.
   *
   * OMITTING it (or the whole options object) keeps the pre-#253 behavior — an
   * unconditional append.
   *
   * `null` rather than `undefined` for the empty log is what keeps "absent"
   * meaning only one thing. `readHeadEventId` answers that case with
   * `undefined`, so a caller piping it straight through would silently DISABLE
   * the guard on exactly the store where it is cheapest to get wrong — a brand
   * new one. `exactOptionalPropertyTypes` (tsconfig.base.json) makes that a
   * compile error rather than a convention: an optional property does not
   * accept an explicit `undefined`, so `{ expectedHead: await
   * readHeadEventId(id) }` will not typecheck until the caller writes
   * `?? null` and says which case it means.
   *
   * Read the head BEFORE the basis, never after: an append landing between the
   * two then makes the basis newer than the head and the check errs toward a
   * spurious rejection (costs a re-read), where the reverse order would let the
   * check PASS on a basis that is already stale.
   *
   * That guarantee covers only a race BETWEEN the two reads — an append
   * landing after the basis was already read. It says nothing about a basis
   * that was ALREADY stale before either read: when "the basis" is a derived
   * cursor or projection that a concurrent writer advances separately from
   * its own append (e.g. committed at the very end of that writer's own
   * run, after its append already landed), head-before-basis ordering here
   * does not guarantee that cursor has caught up — the check can still PASS
   * while the caller's basis is behind the log. See #296
   * (`docs/consolidate-evidence-binding-adjudication.md`), which adjudicated
   * that gap for `consolidateBoundary` and closed it by binding the basis to
   * the log: derive the basis from a `readEvents` array instead of from a
   * separately-advanced cursor or projection, and it can no longer be behind
   * the log at all. That is the shape every caller of this option now uses
   * (#253, #270, #298).
   *
   * Binding the basis does NOT relax the ordering rule above — it is what makes
   * the rule sufficient. Keep stamping this head first and reading every basis
   * after it: a caller whose basis is a log replay can then prove the two agree
   * (nothing landed in between, or the check refuses), and a caller with a
   * basis the log cannot express at all — `consolidateBoundary`'s conversation
   * slice — gets the only cover available to it, since there is no array to
   * derive that one from. #298 (PR #299 review) shipped the reverse order for
   * exactly one basis and reopened the gap on that axis.
   */
  expectedHead?: string | null;
}

/**
 * Append several events as ONE atomic unit. All inserts run inside a single
 * `db.transaction(...)` so a throw partway through (e.g. a non-serializable
 * payload) rolls the whole batch back — the append-only log never ends up
 * with a partial logical operation. Insert order = the order of `inputs`,
 * which becomes the `seq` (replay) order.
 *
 * With {@link AppendEventsOptions.expectedHead} the batch additionally becomes
 * a compare-and-append: the head is re-read INSIDE that same transaction and
 * the whole batch is refused when it has moved. Inside is the entire point —
 * comparing before `BEGIN` would just be one more read-then-write span, the
 * very shape this option exists to close. The refusal rolls back exactly like
 * any other throw in the block, so there is no partial append to clean up.
 *
 * Use this when a single logical operation emits multiple back-to-back
 * events; single-event flows keep using `appendEvent`.
 */
export async function appendEvents<TPayload extends DomainEventPayload>(
  projectId: string,
  inputs: AppendEventInput<TPayload>[],
  options?: AppendEventsOptions,
): Promise<DomainEvent<TPayload>[]> {
  const events: DomainEvent<TPayload>[] = inputs.map((input) => {
    const timestamp = nowIso();
    return {
      id: createId("evt"),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: timestamp,
      updatedAt: timestamp,
      type: input.type,
      projectId: input.projectId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      actor: input.actor,
      writer: input.writer ?? input.actor,
      sourceProjectId: input.sourceProjectId ?? input.projectId,
      payload: input.payload,
    };
  });

  const db = getDb(projectId);
  const expectedHead = options?.expectedHead;
  const batch = db.transaction(() => {
    if (expectedHead !== undefined) {
      const actualHead = headEventId(db) ?? null;
      if (actualHead !== expectedHead) {
        throw new StaleHeadError(projectId, expectedHead, actualHead);
      }
    }
    for (const event of events) {
      insertEvent(db, event);
    }
  });

  if (expectedHead === undefined) {
    // Unchanged path: a DEFERRED transaction, exactly as before this option
    // existed.
    batch();
  } else {
    // BEGIN IMMEDIATE takes the write lock up front, so the head read above
    // and the inserts below cannot straddle another connection's commit. A
    // deferred transaction would start its read snapshot first and only then
    // try to upgrade — in WAL that upgrade fails with SQLITE_BUSY_SNAPSHOT
    // when someone committed in between, which `busy_timeout` cannot wait out
    // (retrying would need a NEW snapshot) and which would surface the lost
    // race as an opaque SQLite error instead of `StaleHeadError`. Only this
    // path takes the stronger lock; `busy_timeout = 5000` (db.ts) covers the
    // wait for it.
    batch.immediate();
  }
  return events;
}

interface EventRow {
  id: string;
  schema_version: string;
  created_at: string;
  updated_at: string;
  type: DomainEventType;
  project_id: string;
  scope_type: DomainEvent["scopeType"];
  scope_id: string;
  actor: string;
  writer: string | null;
  source_project_id: string | null;
  payload: string;
}

function rowToEvent(row: EventRow): DomainEvent {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    type: row.type,
    projectId: row.project_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    actor: row.actor,
    // Spread (not assign) so absent provenance stays absent under
    // exactOptionalPropertyTypes rather than becoming an explicit `undefined`.
    ...(row.writer != null ? { writer: row.writer } : {}),
    ...(row.source_project_id != null ? { sourceProjectId: row.source_project_id } : {}),
    payload: JSON.parse(row.payload) as unknown,
  };
}

export interface EventIntegrity {
  events: DomainEvent[];
}

export async function readEventsWithIntegrity(projectId: string): Promise<EventIntegrity> {
  // `seq` (autoincrement primary key) is the deterministic replay order,
  // replacing the old filename + line ordering. SQLite stores whole rows,
  // so there is no partial-line corruption to report. Whole-DB corruption is
  // covered by `PRAGMA integrity_check` in repair-service's doctor.
  const rows = getDb(projectId).prepare("SELECT * FROM events ORDER BY seq").all() as EventRow[];
  return { events: rows.map(rowToEvent) };
}

export async function readEvents(projectId: string): Promise<DomainEvent[]> {
  const { events } = await readEventsWithIntegrity(projectId);
  return events;
}

/**
 * Events strictly after the row whose `id` is `sinceEventId`, in `seq` order.
 * When `sinceEventId` is undefined (or not found in the log) every event is
 * returned — matching the old array-scan semantics of sliceEventsSince.
 */
export async function readEventsSince(
  projectId: string,
  sinceEventId: string | undefined,
): Promise<DomainEvent[]> {
  const db = getDb(projectId);
  if (!sinceEventId) {
    return (db.prepare("SELECT * FROM events ORDER BY seq").all() as EventRow[]).map(rowToEvent);
  }
  const watermark = db.prepare("SELECT seq FROM events WHERE id = ?").get(sinceEventId) as
    { seq: number } | undefined;
  if (!watermark) {
    // Unknown watermark — fall back to "everything", as the old findIndex
    // did when the id was not present in the log.
    return (db.prepare("SELECT * FROM events ORDER BY seq").all() as EventRow[]).map(rowToEvent);
  }
  const rows = db
    .prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq")
    .all(watermark.seq) as EventRow[];
  return rows.map(rowToEvent);
}

/**
 * Every `project.created` (genesis) event in the log, in `seq` order. Cheap
 * even on a large store — a workspace union has at most one per member, so
 * this is a handful of rows regardless of total event count. Used (#113) to
 * resolve `laneOf`'s `isUnion` flag without a full `readEvents` replay, e.g.
 * when a boundary needs the self/foreign classification for a `readEventsSince`
 * window without paying for the whole log.
 */
export async function readGenesisEvents(projectId: string): Promise<DomainEvent[]> {
  return readGenesisEventsSync(projectId);
}

/** {@link readGenesisEvents} for SYNC callers. The read itself was always
 *  synchronous (the async signature is this module's convention); the
 *  consolidation THRESHOLD path needs the same self/foreign classification and
 *  is sync all the way up to `shouldTriggerThresholdConsolidate`, so it takes
 *  this door rather than forcing a public API to go async. */
export function readGenesisEventsSync(projectId: string): DomainEvent[] {
  const rows = getDb(projectId)
    .prepare("SELECT * FROM events WHERE type = 'project.created' ORDER BY seq")
    .all() as EventRow[];
  return rows.map(rowToEvent);
}

/** The id of the newest event (max `seq`), or undefined for an empty log.
 *  Cheap local head probe — a watcher's push gate can compare this against a
 *  persisted push watermark so an idle tick never builds the full event array
 *  just to learn nothing changed. */
export async function readHeadEventId(projectId: string): Promise<string | undefined> {
  return headEventId(getDb(projectId));
}

/**
 * Events up to AND INCLUDING the revision identified by `upToEventId`, in `seq`
 * order — state-as-of-revision. Mirrors `readEventsSince` but with an
 * inclusive upper bound (`seq <= …`) and a strict throw on an unknown revision
 * (a time-travel read must not silently return HEAD). The revision key is the
 * stable `eventId`, not the machine-local `seq`. Per-project db, so no
 * `project_id` filter — a foreign eventId is simply absent and throws.
 */
export async function readEventsUpTo(
  projectId: string,
  upToEventId: string,
): Promise<DomainEvent[]> {
  const db = getDb(projectId);
  const watermark = db.prepare("SELECT seq FROM events WHERE id = ?").get(upToEventId) as
    { seq: number } | undefined;
  if (!watermark) {
    throw new MemorizeError(`Revision ${upToEventId} not found in project ${projectId}.`);
  }
  const rows = db
    .prepare("SELECT * FROM events WHERE seq <= ? ORDER BY seq")
    .all(watermark.seq) as EventRow[];
  return rows.map(rowToEvent);
}

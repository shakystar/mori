import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createConflict,
  createConsolidatedMemory,
  createDecision,
  createHandoff,
  createObservation,
  createProject,
  createRule,
  createSession,
  createTask,
  createWorkstream,
} from '../../src/domain/entities.js';
import { rebuildProjectProjection } from '../../src/services/projection-store.js';
import { appendEvent } from '../../src/storage/event-store.js';
import { closeAll, getDb } from '../../src/storage/db.js';

/**
 * The event log is the source of truth (#10): every projection table must be
 * fully reconstructable from it alone, with no dependency on an LLM or the
 * network. `rebuildProjectProjection` / `reduceProjectState` never import
 * anything network- or LLM-shaped (no fetch, no provider client) — this test
 * exercises that path end to end and would hang/throw here if that ever
 * stopped being true, since nothing in this file mocks a network boundary.
 *
 * `embeddings` and `segments` are deliberately excluded from the snapshot:
 * both are DERIVED-but-NOT-rebuilt tables (v8/v10, filled out-of-band by the
 * not-yet-ported services layer, #11) — the projector never touches them, so
 * they carry no rebuild guarantee to test.
 */

const SNAPSHOT_TABLES = [
  'projects',
  'memory_index',
  'workstreams',
  'tasks',
  'task_requests',
  'handoffs',
  'checkpoints',
  'decisions',
  'rules',
  'conflicts',
  'sessions',
  'observations',
  'memories',
] as const;

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'mori-rebuild-guarantee-'));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

/**
 * `memory_index.data.generatedAt` is stamped from wall-clock `nowIso()`
 * (buildMemoryIndex), not derived from the event log — by design it is "when
 * this projection was built", not project state, so two rebuilds of the same
 * log legitimately produce two different timestamps here. Strip it before
 * comparing; every other field must still match exactly.
 */
function normalizeMemoryIndexRow(row: { data: string }): { data: string } {
  const data = JSON.parse(row.data) as { generatedAt?: string };
  delete data.generatedAt;
  return { data: JSON.stringify(data) };
}

function snapshot(projectId: string): Record<string, unknown[]> {
  const db = getDb(projectId);
  const snap: Record<string, unknown[]> = {};
  for (const table of SNAPSHOT_TABLES) {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Array<{
      data: string;
    }>;
    snap[table] =
      table === 'memory_index' ? rows.map(normalizeMemoryIndexRow) : rows;
  }
  // search_fts is a virtual FTS5 table with no stable rowid ordering
  // guarantee across a wipe + reinsert, so sort by its own columns.
  snap.search_fts = db
    .prepare(
      'SELECT entity_id, kind, text, source_project_id FROM search_fts ORDER BY entity_id, kind',
    )
    .all() as unknown[];
  return snap;
}

function wipeAllProjections(projectId: string): void {
  const db = getDb(projectId);
  db.transaction(() => {
    for (const table of SNAPSHOT_TABLES) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    db.prepare('DELETE FROM search_fts').run();
  })();
}

describe('projection rebuild guarantee (event log is source of truth)', () => {
  it('wiping every projection table and rebuilding from the event log alone reproduces the same state', async () => {
    const projectId = 'proj_rebuild_guarantee1';
    const ts = '2026-07-01T00:00:00.000Z';

    const project = createProject({ title: 'Rebuild Guarantee', rootPath: '/tmp/rebuild' });
    await appendEvent({
      type: 'project.created',
      projectId,
      scopeType: 'project',
      scopeId: projectId,
      actor: 'test',
      payload: { ...project, id: projectId },
    });

    const workstream = createWorkstream({ projectId, title: 'main' });
    await appendEvent({
      type: 'workstream.created',
      projectId,
      scopeType: 'workstream',
      scopeId: workstream.id,
      actor: 'test',
      payload: workstream,
    });

    const task = createTask({ projectId, workstreamId: workstream.id, title: 'Task A' });
    await appendEvent({
      type: 'task.created',
      projectId,
      scopeType: 'task',
      scopeId: task.id,
      actor: 'test',
      payload: task,
    });
    await appendEvent({
      type: 'task.updated',
      projectId,
      scopeType: 'task',
      scopeId: task.id,
      actor: 'test',
      payload: { status: 'in_progress' },
    });
    await appendEvent({
      type: 'task.item-appended',
      projectId,
      scopeType: 'task',
      scopeId: task.id,
      actor: 'test',
      payload: { field: 'openQuestions', text: 'What is the rebuild invariant?' },
    });

    const decisionOld = createDecision({
      scopeType: 'project',
      scopeId: projectId,
      title: 'Old decision',
      decision: 'Do it the old way',
      rationale: 'Seemed fine then',
      createdBy: 'test',
    });
    await appendEvent({
      type: 'decision.accepted',
      projectId,
      scopeType: 'project',
      scopeId: projectId,
      actor: 'test',
      payload: decisionOld,
    });
    const decisionNew = createDecision({
      scopeType: 'project',
      scopeId: projectId,
      title: 'New decision',
      decision: 'Do it the new way',
      rationale: 'Old way had a bug',
      createdBy: 'test',
    });
    await appendEvent({
      type: 'decision.accepted',
      projectId,
      scopeType: 'project',
      scopeId: projectId,
      actor: 'test',
      payload: decisionNew,
    });
    await appendEvent({
      type: 'decision.superseded',
      projectId,
      scopeType: 'project',
      scopeId: decisionOld.id,
      actor: 'test',
      payload: {
        supersedes: decisionOld.id,
        supersededBy: decisionNew.id,
        reason: 'replaced',
      },
    });

    const handoff = createHandoff({
      projectId,
      taskId: task.id,
      fromActor: 'claude',
      toActor: 'next-agent',
      summary: 'Set up the rebuild guarantee test',
      nextAction: 'Run the suite',
    });
    await appendEvent({
      type: 'handoff.created',
      projectId,
      scopeType: 'task',
      scopeId: task.id,
      actor: 'claude',
      payload: handoff,
    });

    const rule = createRule({
      scopeType: 'project',
      scopeId: projectId,
      title: 'Imported rule',
      body: 'Keep commits small',
      updatedBy: 'test',
      source: 'imported',
    });
    await appendEvent({
      type: 'rule.upserted',
      projectId,
      scopeType: 'project',
      scopeId: projectId,
      actor: 'test',
      payload: rule,
    });

    const conflict = createConflict({
      projectId,
      scopeType: 'rule',
      scopeId: projectId,
      fieldPath: 'commit_style',
      leftVersion: 'small_commits',
      rightVersion: 'squash_final_commit',
      conflictType: 'rule',
    });
    await appendEvent({
      type: 'conflict.detected',
      projectId,
      scopeType: 'project',
      scopeId: projectId,
      actor: 'test',
      payload: conflict,
    });

    const session = createSession({ projectId, actor: 'claude', taskId: task.id });
    await appendEvent({
      type: 'session.started',
      projectId,
      scopeType: 'session',
      scopeId: session.id,
      actor: 'claude',
      payload: session,
    });
    await appendEvent({
      type: 'session.heartbeat',
      projectId,
      scopeType: 'session',
      scopeId: session.id,
      actor: 'claude',
      payload: { sessionId: session.id, at: ts },
    });

    const observation = createObservation({
      projectId,
      sessionId: session.id,
      signal: 'tool-use',
      summary: 'ran a build',
    });
    await appendEvent({
      type: 'observation.captured',
      projectId,
      scopeType: 'session',
      scopeId: session.id,
      actor: 'claude',
      payload: observation,
    });

    const memoryOld = createConsolidatedMemory({
      projectId,
      kind: 'decision',
      text: 'We used to do it the old way',
      salience: 5,
      sourceObservationIds: [observation.id],
    });
    await appendEvent({
      type: 'memory.consolidated',
      projectId,
      scopeType: 'project',
      scopeId: projectId,
      actor: 'claude',
      payload: memoryOld,
    });
    const memoryNew = createConsolidatedMemory({
      projectId,
      kind: 'decision',
      text: 'We now do it the new way',
      salience: 6,
      sourceObservationIds: [observation.id],
    });
    await appendEvent({
      type: 'memory.consolidated',
      projectId,
      scopeType: 'project',
      scopeId: projectId,
      actor: 'claude',
      payload: memoryNew,
    });
    await appendEvent({
      type: 'memory.superseded',
      projectId,
      scopeType: 'project',
      scopeId: memoryOld.id,
      actor: 'claude',
      payload: {
        supersedes: memoryOld.id,
        supersededBy: memoryNew.id,
        reason: 'replaced by newer decision',
      },
    });

    // Rebuild to steady state before snapshotting. The very first rebuild of
    // a project with imported rules is a special case: the topic `.md`
    // content file doesn't exist yet, so buildMemoryIndex/topicSearchRows
    // fall back to the in-event `rule.body`; every rebuild after that reads
    // the now-persisted topic file back, which is a distinct (but equally
    // valid, and from then on completely stable) code path. A real project
    // is rebuilt many times over its life, so steady state — not the one-off
    // first build — is the state this guarantee is about.
    await rebuildProjectProjection(projectId);
    await rebuildProjectProjection(projectId);
    const before = snapshot(projectId);

    // Every table has at least one row, otherwise the equality check below
    // would vacuously pass on empty tables and guard nothing.
    for (const table of SNAPSHOT_TABLES) {
      if (table === 'task_requests' || table === 'checkpoints') continue; // not seeded above
      expect((before[table] as unknown[]).length, `${table} should have rows before wipe`).toBeGreaterThan(0);
    }
    expect((before.search_fts as unknown[]).length).toBeGreaterThan(0);

    // Simulate total projection loss (corruption, a bad migration, whatever)
    // — the event log is untouched.
    wipeAllProjections(projectId);
    for (const table of SNAPSHOT_TABLES) {
      expect(getDb(projectId).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }

    // Rebuild from the event log alone — no network, no LLM, nothing but
    // the events already on disk.
    await rebuildProjectProjection(projectId);
    const after = snapshot(projectId);

    expect(after).toEqual(before);
  });
});

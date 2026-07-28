import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createConflict,
  createDecision,
  createProject,
  createRule,
  createSession,
  createTask,
  createWorkstream,
} from '../../src/domain/entities.js';
import { rebuildProjectProjection } from '../../src/services/projection-store.js';
import { appendEvent } from '../../src/storage/event-store.js';
import { closeAll, getDb } from '../../src/storage/db.js';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'mori-pcol-'));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

/**
 * For every projection table that duplicates entity fields into extracted
 * SQL columns, the column value MUST equal the corresponding field inside the
 * row's `data` JSON. Readers split trust (getTask parses `data`; listTasks
 * filters/sorts on the columns); they only agree because one INSERT writes
 * both from the same object. Nothing enforces that — this is the guard.
 *
 * The upstream memorize version of this test drives the fixture through the
 * services layer (project/task/session-service) — that layer is #11 scope,
 * not yet ported here, so this drives the same shapes directly through the
 * domain factories + appendEvent instead.
 */
describe('projection column == data JSON consistency', () => {
  it('every extracted column matches its parsed data field across tables', async () => {
    const project = createProject({ title: 'Cols', rootPath: '/tmp/cols' });
    const projectId = project.id;
    await appendEvent({
      type: 'project.created',
      projectId,
      scopeType: 'project',
      scopeId: projectId,
      actor: 'test',
      payload: project,
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

    // Tasks with different statuses + a workstream link + an update so
    // created_at and updated_at can diverge.
    const todo = createTask({
      projectId,
      workstreamId: workstream.id,
      title: 'Todo task',
    });
    await appendEvent({
      type: 'task.created',
      projectId,
      scopeType: 'task',
      scopeId: todo.id,
      actor: 'test',
      payload: todo,
    });

    const doing = createTask({
      projectId,
      workstreamId: workstream.id,
      title: 'In-progress task',
    });
    await appendEvent({
      type: 'task.created',
      projectId,
      scopeType: 'task',
      scopeId: doing.id,
      actor: 'test',
      payload: doing,
    });
    await appendEvent({
      type: 'task.updated',
      projectId,
      scopeType: 'task',
      scopeId: doing.id,
      actor: 'test',
      payload: { status: 'in_progress' },
    });

    // A session (sessions.status).
    const session = createSession({ projectId, actor: 'claude' });
    await appendEvent({
      type: 'session.started',
      projectId,
      scopeType: 'session',
      scopeId: session.id,
      actor: 'claude',
      payload: session,
    });

    // A decision (decisions.status).
    const decision = createDecision({
      scopeType: 'project',
      scopeId: projectId,
      title: 'Use SQLite',
      decision: 'Adopt SQLite event store',
      rationale: 'Single-file durability',
      createdBy: 'test',
    });
    await appendEvent({
      type: 'decision.proposed',
      projectId,
      scopeType: 'project',
      scopeId: projectId,
      actor: 'test',
      payload: decision,
    });

    // A rule (rules.source).
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

    // A conflict (conflicts.status).
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

    await rebuildProjectProjection(projectId);

    // table → (extracted column → field path inside parsed `data`).
    const tableColumns: Record<string, Record<string, string>> = {
      workstreams: { status: 'status' },
      tasks: {
        status: 'status',
        workstream_id: 'workstreamId',
        created_at: 'createdAt',
        updated_at: 'updatedAt',
      },
      decisions: { status: 'status' },
      rules: { source: 'source' },
      conflicts: { status: 'status' },
      sessions: { status: 'status' },
    };

    const db = getDb(projectId);
    for (const [table, columns] of Object.entries(tableColumns)) {
      const colNames = Object.keys(columns);
      const rows = db
        .prepare(`SELECT ${colNames.join(', ')}, data FROM ${table}`)
        .all() as Array<Record<string, unknown> & { data: string }>;

      // Each table must contribute at least one row, otherwise the assertion
      // below vacuously passes and the test guards nothing.
      expect(rows.length, `${table} should have rows`).toBeGreaterThan(0);

      for (const row of rows) {
        const data = JSON.parse(row.data) as Record<string, unknown>;
        for (const [column, field] of Object.entries(columns)) {
          // null column ⇔ undefined field (the projection writes `?? null`).
          const columnValue = row[column] ?? undefined;
          expect(
            columnValue,
            `${table}.${column} must equal data.${field}`,
          ).toBe(data[field]);
        }
      }
    }
  });
});

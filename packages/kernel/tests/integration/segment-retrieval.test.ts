import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProject } from '../../src/domain/entities.js';
import { retrieveSegments } from '../../src/services/memory-retrieval-service.js';
import { rebuildProjectProjection } from '../../src/services/projection-store.js';
import { hybridSearchSegments, searchByKind } from '../../src/services/search-service.js';
import { listSegmentTexts } from '../../src/services/segment-store.js';
import { closeAll, getDb } from '../../src/storage/db.js';
import { appendEvent } from '../../src/storage/event-store.js';

/**
 * The upstream memorize suite seeds `segments` rows via the service-layer
 * `insertSegments` — the segments WRITE path belongs to consolidate-service
 * (#64), not this slice (#62 body: "쓰기 경로는 이 조각의 범위가 아니다").
 * Fixtures here insert directly into the `segments` table instead; only the
 * read helpers (`listSegmentTexts`, `searchByKind`, `hybridSearchSegments`,
 * `retrieveSegments`) are under test.
 */
let sandbox: string;
let projectId: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'mori-seg-retrieval-'));
  process.env.MEMORIZE_ROOT = sandbox;

  const project = createProject({ title: 'seg', rootPath: '/tmp/seg' });
  projectId = project.id;
  await appendEvent({
    type: 'project.created',
    projectId,
    scopeType: 'project',
    scopeId: projectId,
    actor: 'test',
    payload: project,
  });
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

function insertSegment(id: string, text: string, createdAt: string): void {
  getDb(projectId)
    .prepare(
      'INSERT INTO segments (id, session_id, created_at, ordinal, source, text) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, 's1', createdAt, 0, null, text);
}

describe('segment-store reads', () => {
  it('listSegmentTexts hydrates text by id', async () => {
    insertSegment('seg_1', 'alpha', '2026-01-01T00:00:00.000Z');
    insertSegment('seg_2', 'beta', '2026-02-01T00:00:00.000Z');
    expect(listSegmentTexts(projectId).get('seg_1')).toBe('alpha');
    expect(listSegmentTexts(projectId).get('seg_2')).toBe('beta');
  });
});

describe('segment search + retrieval', () => {
  it('reindex emits kind=segment FTS rows; searchByKind/hybrid find them', async () => {
    insertSegment('seg_a', 'the navy blazer dry cleaning pickup', '2026-01-01T00:00:00.000Z');
    await rebuildProjectProjection(projectId, { reindexSearch: true });

    const hits = searchByKind(projectId, 'blazer dry cleaning', 'segment');
    expect(hits.map((h) => h.entityId)).toContain('seg_a');

    const hybrid = await hybridSearchSegments(projectId, 'blazer dry cleaning');
    expect(hybrid.length).toBeGreaterThan(0);
    expect(hybrid.map((h) => h.entityId)).toContain('seg_a');
    expect(hybrid[0]!.snippet.length).toBeGreaterThan(0);
  });

  it('reindex with no segments is a no-op (no kind=segment rows)', async () => {
    await rebuildProjectProjection(projectId, { reindexSearch: true });
    expect(searchByKind(projectId, 'anything', 'segment')).toHaveLength(0);
  });

  it('retrieveSegments returns full text within budget; empty without a task', async () => {
    insertSegment(
      'seg_b',
      'alpha beta gamma project timeline planning',
      '2026-01-01T00:00:00.000Z',
    );
    await rebuildProjectProjection(projectId, { reindexSearch: true });

    expect(await retrieveSegments(projectId, {})).toEqual([]);
    const got = await retrieveSegments(projectId, { taskTitle: 'project timeline' });
    expect(got.map((s) => s.id)).toContain('seg_b');
    expect(got.find((s) => s.id === 'seg_b')!.text).toContain('project timeline');
  });

  it('retrieveSegments respects its char budget', async () => {
    insertSegment('seg_x', 'budgetword '.repeat(40), '2026-01-02T00:00:00.000Z');
    insertSegment('seg_y', 'budgetword '.repeat(40), '2026-01-01T00:00:00.000Z');
    await rebuildProjectProjection(projectId, { reindexSearch: true });
    const got = await retrieveSegments(projectId, { taskTitle: 'budgetword', budgetChars: 500 });
    const totalChars = got.reduce((n, s) => n + s.text.length, 0);
    expect(totalChars).toBeLessThanOrEqual(500);
  });
});

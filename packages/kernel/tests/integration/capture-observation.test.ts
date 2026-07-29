import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProject } from '../../src/domain/entities.js';
import { captureObservation } from '../../src/services/capture-service.js';
import { listRecentObservations } from '../../src/services/projection-store.js';
import { closeAll } from '../../src/storage/db.js';
import { appendEvent, readEvents } from '../../src/storage/event-store.js';

let sandbox: string;
const projectId = 'proj_capture_test1';

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'mori-capture-'));
  process.env.MEMORIZE_ROOT = sandbox;

  const project = createProject({ title: 'Capture Test', rootPath: sandbox });
  await appendEvent({
    type: 'project.created',
    projectId,
    scopeType: 'project',
    scopeId: projectId,
    actor: 'test',
    payload: { ...project, id: projectId },
  });
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('captureObservation (kernel-native entry point)', () => {
  it('appends an observation.captured event and a queryable projection row for a write signal', async () => {
    const captured = await captureObservation({
      projectId,
      actor: 'mori',
      sessionId: 'sess_1',
      toolName: 'Write',
      toolInputText: '/repo/src/index.ts',
    });

    expect(captured?.signal).toBe('write-tool');
    expect(captured?.filePath).toBe('/repo/src/index.ts');

    const types = (await readEvents(projectId)).map((e) => e.type);
    expect(types.filter((t) => t === 'observation.captured')).toHaveLength(1);

    const observations = listRecentObservations(projectId, { limit: 10 });
    expect(observations).toHaveLength(1);
    expect(observations[0]!.summary).toContain('/repo/src/index.ts');
    expect(observations[0]!.sessionId).toBe('sess_1');
  });

  it('rejects a read-only tool: no event appended, undefined returned', async () => {
    const rejected = await captureObservation({
      projectId,
      actor: 'mori',
      sessionId: 'sess_1',
      toolName: 'Read',
      toolInputText: '/repo/src/index.ts',
    });

    expect(rejected).toBeUndefined();
    const types = (await readEvents(projectId)).map((e) => e.type);
    expect(types.filter((t) => t === 'observation.captured')).toHaveLength(0);
  });

  it('falls back to the project as scope when no session id is resolved', async () => {
    const captured = await captureObservation({
      projectId,
      actor: 'mori',
      toolName: 'Bash',
      toolInputText: 'git commit -m "wip"',
    });

    expect(captured?.signal).toBe('mutating-bash');
    expect(captured?.sessionId).toBeUndefined();

    const events = await readEvents(projectId);
    const observationEvent = events.find((e) => e.type === 'observation.captured');
    expect(observationEvent?.scopeId).toBe(projectId);
  });
});

/**
 * #255 (idea #189 A) — `sliceFullyStored`'s durable judgment used to trust
 * only the pruning THIS boundary's own `pruneSegments` call reported, never
 * the table's actual state. A concurrent process's `pruneSegments`
 * (unguarded by the project lock — see `storage/project-lock.ts`'s
 * `pruneSegments` section) can delete the very segments a slice's "fully
 * stored" claim depends on, any time between that claim being computed and
 * the conversation offset being committed on the strength of it. Left
 * unguarded, the offset advances past raw conversation text whose one
 * durable copy is already gone — a real loss, not staleness.
 *
 * Two real `consolidate()` calls stepping in lockstep would only land in
 * that window by luck — the interleave needs a DELETE inside the specific
 * gap between this boundary's OWN prune (which leaves its just-written
 * segments intact) and its cursor commit, and that gap is an `await`, so no
 * fake clock can express it. `vi.mock` seam-injects the DELETE
 * deterministically: `rebuildProjectProjection` is the one call this
 * scenario is guaranteed to make exactly once, after the boundary's own
 * prune and before its cursor commit (`segmentsWritten > 0` but no
 * memories, so `ensureEmbeddings`/`detectContradictions` are skipped and
 * `ensureSegmentEmbeddings` no-ops without an embedder). The mock calls the
 * REAL `pruneSegments` from inside it — standing in for a second process's
 * boundary — then calls the real `rebuildProjectProjection` through.
 * TESTING.md's timing-race exception applies: the actual implementation is
 * spread and called through unmodified, and the assertions below are on the
 * conversation offset actually committed and the attempt's
 * `conversationSliceHeld` flag, not on the mock's call log.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProject } from "../../src/domain/entities.js";
import type { ConversationSlice, ConversationSource } from "../../src/index.js";
import {
  MAX_EXTRACTION_INPUT_CHARS,
  consolidate,
  readLastConsolidateAttempt,
  type Consolidator,
} from "../../src/services/consolidate-service.js";
import { closeAll } from "../../src/storage/db.js";
import { appendEvent } from "../../src/storage/event-store.js";

const armed = vi.hoisted(() => ({ on: false }));

vi.mock("../../src/services/projection-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/projection-store.js")>();
  return {
    ...actual,
    rebuildProjectProjection: async (
      projectId: string,
      opts?: Parameters<typeof actual.rebuildProjectProjection>[1],
    ) => {
      if (armed.on) {
        armed.on = false;
        // Stands in for a second process's boundary racing `pruneSegments`
        // over the same table, unguarded by the project lock — deletes
        // everything this boundary just inserted before it reaches its own
        // cursor commit.
        const { pruneSegments } = await import("../../src/services/segment-store.js");
        pruneSegments(projectId, { maxCount: 0 });
      }
      return actual.rebuildProjectProjection(projectId, opts);
    },
  };
});

let sandbox: string;
let projectId: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-segment-race-"));
  process.env.MEMORIZE_ROOT = sandbox;
  armed.on = false;

  const project = createProject({ title: "segment race", rootPath: join(sandbox, "p") });
  projectId = project.id;
  await appendEvent({
    type: "project.created",
    projectId,
    scopeType: "project",
    scopeId: projectId,
    actor: "test",
    payload: project,
  });
});

afterEach(async () => {
  closeAll();
  armed.on = false;
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

/** A conversation several times `MAX_EXTRACTION_INPUT_CHARS`, no single turn
 *  of which is oversized — so with the raw buffer on and no room to reserve
 *  even a resumable prefix, the ONLY thing that can justify draining it is
 *  the stored copy (`sliceFullyStored`), never a shown prefix. */
function oversizedConversation(): string {
  const turns = Array.from({ length: 400 }, (_, i) => `USER: turn ${i} ${"detail ".repeat(20)}`);
  const full = turns.join("\n\n");
  expect(full.length).toBeGreaterThan(MAX_EXTRACTION_INPUT_CHARS * 3);
  return full;
}

function fakeStreamConversation(full: string): ConversationSource & { offsets: number[] } {
  const offsets: number[] = [];
  return {
    id: "conv-stream",
    offsets,
    async read(offset: number): Promise<ConversationSlice | undefined> {
      offsets.push(offset);
      if (offset >= full.length) return undefined;
      return { text: full.slice(offset), newOffset: full.length, resumePoints: [] };
    },
  };
}

describe("consolidate — cross-process pruneSegments race on the durable-slice check (#255)", () => {
  it("holds the conversation cursor instead of advancing past segments a concurrent prune just deleted", async () => {
    const full = oversizedConversation();
    const conversation = fakeStreamConversation(full);
    const consolidator: Consolidator = {
      async extract() {
        return [];
      },
    };

    armed.on = true;
    const result = await consolidate({ projectId, actor: "test", conversation, consolidator });

    // No shown-whole, no resumable prefix (raw buffer on, oversized) — the
    // pre-fix code would have trusted `sliceFullyStored` and advanced past
    // content the concurrent prune had already deleted.
    expect(result.segmentsWritten).toBeGreaterThan(0);
    expect(result.conversationSliceHeld).toBe(true);
    expect(readLastConsolidateAttempt(projectId)?.conversationSliceHeld).toBe(true);

    // The cursor never moved, so the next boundary re-reads from the start —
    // nothing was consumed on the strength of a copy that no longer exists.
    const again = await consolidate({ projectId, actor: "test", conversation, consolidator });
    expect(conversation.offsets).toEqual([0, 0]);
    expect(again.segmentsWritten).toBeGreaterThan(0);
  });

  it("still drains fully when nothing races the prune", async () => {
    const full = oversizedConversation();
    const conversation = fakeStreamConversation(full);
    const consolidator: Consolidator = {
      async extract() {
        return [];
      },
    };

    // armed.on stays false: rebuildProjectProjection runs unmodified, so
    // this boundary's own segments survive and sliceFullyStored legitimately
    // holds — the guard must not hold the cursor when nothing invalidated it.
    const result = await consolidate({ projectId, actor: "test", conversation, consolidator });
    expect(result.conversationSliceHeld).toBe(false);
    expect(conversation.offsets).toEqual([0]);
  });
});

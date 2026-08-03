/**
 * Session-start injection (#149, #5 1/3): what `SqliteMemoryKernel.transformContext`
 * puts in front of the agent's first LLM call, and — mostly — what it refuses to.
 *
 * Integration rather than unit because the behaviour under test is the seam
 * meeting the store: the same kernel captures an observation, projects it, and
 * then retrieves it back through `buildMemoryContext`. A stubbed retrieval would
 * assert nothing about that round trip. The store is a real SQLite file under a
 * temp `MEMORIZE_ROOT`, per TESTING.md.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CURRENT_SCHEMA_VERSION } from "../../src/domain/common.js";
import { createProject } from "../../src/domain/entities.js";
import {
  observedShell,
  SqliteMemoryKernel,
  type ObservedToolCall,
} from "../../src/kernel/sqlite-memory-kernel.js";
import { renderMemoryContext } from "../../src/services/context-render.js";
import { buildMemoryContext, type MemoryContext } from "../../src/services/context-service.js";
import * as memoryRetrievalService from "../../src/services/memory-retrieval-service.js";
import {
  listValidMemories,
  rebuildProjectProjection,
} from "../../src/services/projection-store.js";
import { closeAll } from "../../src/storage/db.js";
import { appendEvent } from "../../src/storage/event-store.js";
import { getProjectDbFile } from "../../src/storage/path-resolver.js";

type FakeEvent = ObservedToolCall;

let sandbox: string;
const projectId = "proj_kernel_injection_test";

/** Marks a rendered context so a returned array can be counted, not just read. */
const MARK = "<<memory>>";

interface Harness {
  kernel: SqliteMemoryKernel<string, FakeEvent>;
  /** Every context the kernel handed to `renderContext`, in call order. */
  rendered: MemoryContext[];
}

function harness(options: { renderContext?: boolean; throwOnRender?: boolean } = {}): Harness {
  const rendered: MemoryContext[] = [];
  const render = (context: MemoryContext): string => {
    rendered.push(context);
    if (options.throwOnRender) throw new Error("renderer exploded");
    return `${MARK}${renderMemoryContext(context)}`;
  };
  const kernel = new SqliteMemoryKernel<string, FakeEvent>({
    projectId,
    actor: "mori",
    project: { title: "kernel injection", rootPath: sandbox },
    observeEvent: (event) => event,
    ...(options.renderContext === false ? {} : { renderContext: render }),
  });
  return { kernel, rendered };
}

/** Store with one captured observation in it — a non-empty memory context. */
async function seedObservation(kernel: SqliteMemoryKernel<string, FakeEvent>): Promise<void> {
  kernel.observe(observedShell({ toolName: "bash", command: "git commit -m 'pick zephyr'" }));
  await kernel.drain();
}

/**
 * A consolidated memory, seeded directly (not via `observe`/`consolidate`) —
 * only `consolidatedMemories` are reinforced (mori#176), so the reinforcement
 * tests need this channel specifically, not the observation tail that
 * {@link seedObservation} produces.
 */
async function seedMemory(id: string, text: string): Promise<void> {
  const createdAt = "2026-01-01T00:00:00.000Z";
  await appendEvent({
    type: "memory.consolidated",
    projectId,
    scopeType: "project",
    scopeId: projectId,
    actor: "test",
    payload: {
      id,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt,
      updatedAt: createdAt,
      projectId,
      kind: "insight",
      text,
      salience: 5,
      sourceObservationIds: [],
    } as never,
  });
}

/** Store that exists and is healthy but holds nothing retrievable. */
async function seedEmptyStore(): Promise<void> {
  const project = createProject({ title: "kernel injection", rootPath: sandbox });
  await appendEvent({
    type: "project.created",
    projectId,
    scopeType: "project",
    scopeId: projectId,
    actor: "test",
    payload: { ...project, id: projectId },
  });
  await rebuildProjectProjection(projectId);
}

function injectedCount(messages: string[]): number {
  return messages.filter((message) => message.startsWith(MARK)).length;
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-kernel-injection-"));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe("SqliteMemoryKernel.transformContext — session-start injection", () => {
  it("injects the retrieved context as exactly one message at the head", async () => {
    const { kernel, rendered } = harness();
    await seedObservation(kernel);

    const result = await kernel.transformContext(["one", "two"]);

    expect(result).toHaveLength(3);
    expect(result.slice(1)).toEqual(["one", "two"]);
    expect(result[0]).toContain("git commit -m 'pick zephyr'");
    expect(rendered).toHaveLength(1);
  });

  it("does not inject again on later calls of the same session", async () => {
    const { kernel, rendered } = harness();
    await seedObservation(kernel);

    const calls = [
      await kernel.transformContext(["one"]),
      await kernel.transformContext(["one", "two"]),
      await kernel.transformContext(["one", "two", "three"]),
    ];

    expect(calls.map(injectedCount)).toEqual([1, 0, 0]);
    // Not just "injected once" — retrieved once. A silent re-read every turn is
    // turn-level retrieval (#5 2/3) wearing this seam's clothes.
    expect(rendered).toHaveLength(1);
  });

  it("injects nothing when the project has no memories, observations, or segments", async () => {
    const { kernel, rendered } = harness();
    await seedEmptyStore();
    const messages = ["one", "two"];

    await expect(kernel.transformContext(messages)).resolves.toEqual(messages);
    expect(rendered).toEqual([]);
  });

  it("injects nothing, and creates no store, when the project has never been written", async () => {
    const { kernel } = harness();
    const messages = ["one"];

    await expect(kernel.transformContext(messages)).resolves.toEqual(messages);
    // The read must not be what puts mori's memory on disk: a session that only
    // reads files still leaves no trace.
    expect(existsSync(getProjectDbFile(projectId))).toBe(false);
  });

  it("returns the original messages when retrieval throws", async () => {
    // A corrupt store is the real version of "retrieval throws": the file is
    // there, so the store looks present, and the first query fails on it.
    const dbFile = getProjectDbFile(projectId);
    await mkdir(dirname(dbFile), { recursive: true });
    await writeFile(dbFile, "not a database at all");
    const { kernel } = harness();
    const messages = ["one", "two"];

    // Pin the premise: without this the case would pass just as happily if the
    // corrupt store quietly retrieved nothing, testing the empty path twice.
    await expect(buildMemoryContext(projectId)).rejects.toThrow();

    await expect(kernel.transformContext(messages)).resolves.toEqual(messages);
  });

  it("returns the original messages when the harness's renderer throws", async () => {
    const { kernel, rendered } = harness({ throwOnRender: true });
    await seedObservation(kernel);
    const messages = ["one"];

    await expect(kernel.transformContext(messages)).resolves.toEqual(messages);
    expect(rendered).toHaveLength(1);
  });

  it("starts no retrieval when the signal is already aborted, and keeps the attempt", async () => {
    const { kernel, rendered } = harness();
    await seedObservation(kernel);
    const messages = ["one"];

    const aborted = await kernel.transformContext(messages, AbortSignal.abort());

    expect(aborted).toEqual(messages);
    expect(rendered).toEqual([]);
    // The cancelled turn cost the session nothing: the next one still injects.
    expect(injectedCount(await kernel.transformContext(messages))).toBe(1);
  });

  it("passes messages through when the harness supplies no renderer", async () => {
    const { kernel } = harness({ renderContext: false });
    await seedObservation(kernel);
    const messages = ["one", "two"];

    await expect(kernel.transformContext(messages)).resolves.toEqual(messages);
  });

  describe("reinforcement (mori#176)", () => {
    it("reinforces the injected memories once the render has actually succeeded", async () => {
      await seedEmptyStore();
      await seedMemory("mem_a", "chose zephyr as the deploy target");
      await rebuildProjectProjection(projectId);
      const { kernel } = harness();

      const result = await kernel.transformContext(["one"]);

      expect(injectedCount(result)).toBe(1);
      const row = listValidMemories(projectId).find((r) => r.memory.id === "mem_a");
      expect(row?.lastAccessedAt).toBeDefined();
    });

    it("does not reinforce when the harness's renderer throws — the memory was never actually shown", async () => {
      await seedEmptyStore();
      await seedMemory("mem_a", "chose zephyr as the deploy target");
      await rebuildProjectProjection(projectId);
      const { kernel } = harness({ throwOnRender: true });

      await expect(kernel.transformContext(["one"])).resolves.toEqual(["one"]);

      const row = listValidMemories(projectId).find((r) => r.memory.id === "mem_a");
      expect(row?.lastAccessedAt).toBeUndefined();
    });

    it("still returns the rendered injection when reinforcement itself fails", async () => {
      await seedEmptyStore();
      await seedMemory("mem_a", "chose zephyr as the deploy target");
      await rebuildProjectProjection(projectId);
      const { kernel } = harness();
      const spy = vi
        .spyOn(memoryRetrievalService, "reinforceInjectedMemories")
        .mockImplementation(() => {
          throw new Error("reinforcement boom — e.g. a lock held by another process");
        });

      try {
        const result = await kernel.transformContext(["one"]);
        // The bug this guards against (mori#176 ①): a reinforcement failure
        // used to reject buildMemoryContext entirely, which the kernel's catch
        // then treated as a retrieval failure — throwing away a perfectly good,
        // already-retrieved context. Reinforcement now runs after render, on
        // the side, so its failure must not cost the injection that already
        // succeeded.
        expect(injectedCount(result)).toBe(1);
        // Independent evidence that the spy actually intercepted the call
        // (PR #198 review): if the named-import binding had bypassed the
        // spy, reinforcement would have run for real and stamped this row,
        // making the assertion above pass for the wrong reason.
        const row = listValidMemories(projectId).find((r) => r.memory.id === "mem_a");
        expect(row?.lastAccessedAt).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    });
  });
});

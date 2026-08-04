/**
 * Context injection: what `SqliteMemoryKernel.transformContext` puts in front of
 * an LLM call, and — mostly — what it refuses to. Two describes, because the
 * seam has two modes: session-start only (#149, #5 1/3, no `readQuery`) and
 * turn-level (#5 2/3-b, `readQuery` wired).
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
import type { Embedder } from "../../src/index.js";
import {
  observedShell,
  SqliteMemoryKernel,
  type ObservedToolCall,
  type TurnQuery,
} from "../../src/kernel/sqlite-memory-kernel.js";
import { renderMemoryContext } from "../../src/services/context-render.js";
import { buildMemoryContext, type MemoryContext } from "../../src/services/context-service.js";
import * as contextService from "../../src/services/context-service.js";
import * as memoryRetrievalService from "../../src/services/memory-retrieval-service.js";
import {
  listValidMemories,
  rebuildProjectProjection,
} from "../../src/services/projection-store.js";
import { closeAll, getDb } from "../../src/storage/db.js";
import { appendEvent, readEvents } from "../../src/storage/event-store.js";
import * as eventStore from "../../src/storage/event-store.js";
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

function harness(
  options: {
    renderContext?: boolean;
    throwOnRender?: boolean;
    /** The `readQuery` seam. Omitted ⇒ the session-start-only behaviour of #149. */
    readQuery?: (messages: string[]) => TurnQuery | undefined;
    /** The context embedder, i.e. the one await a cancellation can land inside. */
    contextEmbedder?: Embedder;
  } = {},
): Harness {
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
    ...(options.readQuery ? { readQuery: options.readQuery } : {}),
    ...(options.contextEmbedder ? { contextEmbedder: options.contextEmbedder } : {}),
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

  describe("memory.injected event (#5 2/3-a, mori#214)", () => {
    it("appends one memory.injected event, with the injected memory ids, once render succeeds", async () => {
      await seedEmptyStore();
      await seedMemory("mem_a", "chose zephyr as the deploy target");
      await rebuildProjectProjection(projectId);
      const { kernel } = harness();

      const result = await kernel.transformContext(["one"]);

      expect(injectedCount(result)).toBe(1);
      const events = await readEvents(projectId);
      const injected = events.filter((event) => event.type === "memory.injected");
      expect(injected).toHaveLength(1);
      expect(injected[0]?.payload).toEqual({ memoryIds: ["mem_a"] });
    });

    it("appends no memory.injected event when the harness's renderer throws", async () => {
      await seedEmptyStore();
      await seedMemory("mem_a", "chose zephyr as the deploy target");
      await rebuildProjectProjection(projectId);
      const { kernel } = harness({ throwOnRender: true });

      await expect(kernel.transformContext(["one"])).resolves.toEqual(["one"]);

      const events = await readEvents(projectId);
      expect(events.some((event) => event.type === "memory.injected")).toBe(false);
    });

    it("still returns the rendered injection when the memory.injected append itself fails", async () => {
      await seedEmptyStore();
      await seedMemory("mem_a", "chose zephyr as the deploy target");
      await rebuildProjectProjection(projectId);
      const { kernel } = harness();
      const spy = vi.spyOn(eventStore, "appendEvent").mockImplementation(async () => {
        throw new Error("append boom — e.g. a lock held by another process");
      });

      try {
        const result = await kernel.transformContext(["one"]);
        // Same shape of guard as the reinforcement case above: the append
        // failure must not undo the injection already computed and about to
        // be returned.
        expect(injectedCount(result)).toBe(1);
        // Independent evidence the spy actually intercepted the call, not
        // just that the assertion above passed for the wrong reason (PR #198
        // review precedent): if the named-import binding had bypassed the
        // spy, the event would exist in the log.
        const events = await readEvents(projectId);
        expect(events.some((event) => event.type === "memory.injected")).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("turn-level retrieval (#5 2/3-b)", () => {
  /**
   * Segments are the channel a QUERY actually selects (the memory pool is
   * ranked by the query but not filtered by it), so two turns asking
   * different things are only visibly different here. Inserted straight into
   * the table for the same reason segment-retrieval.test.ts does: the write
   * path belongs to consolidation, not to this seam.
   */
  function insertSegment(id: string, text: string): void {
    getDb(projectId)
      .prepare(
        "INSERT INTO segments (id, session_id, created_at, ordinal, source, text) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, "s1", "2026-01-01T00:00:00.000Z", 0, null, text);
  }

  /** Empty store + one memory + one segment per topic, all indexed. */
  async function seedTopics(): Promise<void> {
    await seedEmptyStore();
    await seedMemory("mem_a", "chose zephyr as the deploy target");
    insertSegment("seg_zephyr", "rolling the release out through the zephyr pipeline");
    insertSegment("seg_gamma", "the gamma indexer rebuild took nine minutes");
    await rebuildProjectProjection(projectId, { reindexSearch: true });
  }

  it("retrieves per turn, so two turns with different queries inject different content", async () => {
    await seedTopics();
    let turn: TurnQuery = { query: "zephyr", turnId: "turn-1" };
    const { kernel, rendered } = harness({ readQuery: () => turn });
    // Retrievals are counted, not inferred from injections: the last case below
    // is a turn that retrieves and injects nothing, which is exactly the state
    // an injection-only assertion cannot tell from a turn that never read.
    const retrievals = vi.spyOn(contextService, "buildMemoryContext");

    try {
      const first = await kernel.transformContext(["one"]);
      turn = { query: "gamma", turnId: "turn-2" };
      const second = await kernel.transformContext(["one", "two"]);

      expect(injectedCount(first)).toBe(1);
      expect(first[0]).toContain("zephyr pipeline");
      expect(first[0]).not.toContain("gamma indexer");
      expect(injectedCount(second)).toBe(1);
      expect(second[0]).toContain("gamma indexer");
      expect(second[0]).not.toContain("zephyr pipeline");
      // Two retrievals, not one cached read: the seam ran again for the second
      // query rather than replaying the first turn's context.
      expect(rendered).toHaveLength(2);
      expect(retrievals).toHaveBeenCalledTimes(2);

      // The cache key is the whole TurnQuery, and each half earns its place.
      // The SAME turn asking again must not re-read — this seam runs before
      // every provider call, so a turn that uses twenty tools arrives here
      // twenty more times, each one an FTS read and an embed for content
      // duplicate suppression would discard.
      await kernel.transformContext(["one", "two", "tool result"]);
      expect(retrievals).toHaveBeenCalledTimes(2);

      // A NEW turn that repeats the previous turn's words is not that case and
      // does read: `continue` twice is the most ordinary follow-up an agent
      // REPL has, and by the second one the store holds what the first turn did.
      turn = { query: "gamma", turnId: "turn-3" };
      await kernel.transformContext(["one", "two", "three"]);
      expect(retrievals).toHaveBeenCalledTimes(3);
    } finally {
      retrievals.mockRestore();
    }
  });

  it("never injects the same memory twice, even when the later turn retrieves it again", async () => {
    await seedTopics();
    let turn: TurnQuery = { query: "zephyr", turnId: "turn-1" };
    const { kernel, rendered } = harness({ readQuery: () => turn });

    const first = await kernel.transformContext(["one"]);
    turn = { query: "gamma", turnId: "turn-2" };
    const second = await kernel.transformContext(["one", "two"]);

    expect(first[0]).toContain("chose zephyr as the deploy target");
    // Pin the premise: the second turn's retrieval DID find that memory
    // again (the memory pool is ranked by the query, never filtered by it),
    // so the assertions below are about the injection policy and not about a
    // retrieval that happened to come back empty.
    const retrieved = await buildMemoryContext(projectId, { taskTitle: "gamma" });
    expect(retrieved.consolidatedMemories?.map((memory) => memory.id)).toEqual(["mem_a"]);

    expect(rendered[1]?.consolidatedMemories).toBeUndefined();
    expect(second[0]).not.toContain("chose zephyr as the deploy target");
    // …and the turn still injects what IS new, rather than being suppressed
    // wholesale by the memory it had already shown.
    expect(second[0]).toContain("gamma indexer");
  });

  it("passes the turn through untouched when the query seam throws, and spends nothing", async () => {
    await seedTopics();
    let explode = true;
    const { kernel, rendered } = harness({
      readQuery: () => {
        if (explode) throw new Error("query derivation exploded");
        return { query: "zephyr", turnId: "turn-1" };
      },
    });
    const messages = ["one"];

    await expect(kernel.transformContext(messages)).resolves.toEqual(messages);
    expect(rendered).toEqual([]);

    // The broken turn cost the session nothing — a later turn whose seam
    // works still retrieves and injects.
    explode = false;
    expect(injectedCount(await kernel.transformContext(messages))).toBe(1);
  });

  it("appends one memory.injected per INJECTING turn, carrying that turn's memory ids", async () => {
    await seedTopics();
    let turn: TurnQuery = { query: "zephyr", turnId: "turn-1" };
    const { kernel } = harness({ readQuery: () => turn });

    expect(injectedCount(await kernel.transformContext(["one"]))).toBe(1);
    turn = { query: "gamma", turnId: "turn-2" };
    expect(injectedCount(await kernel.transformContext(["one", "two"]))).toBe(1);

    const events = await readEvents(projectId);
    const injected = events.filter((event) => event.type === "memory.injected");
    // 2/3-a's append is per injection, and turn-level injection is what makes
    // that plural — the condition (render succeeded) is unchanged, more turns
    // now meet it.
    expect(injected).toHaveLength(2);
    expect(injected[0]?.payload).toEqual({ memoryIds: ["mem_a"] });
    // The second turn showed a segment and no memory it had not already
    // shown, so its event says so instead of re-listing mem_a.
    expect(injected[1]?.payload).toEqual({ memoryIds: [] });
  });

  it("records nothing for a turn cancelled mid-retrieval, so a later turn still gets it", async () => {
    await seedTopics();
    const controller = new AbortController();
    // Cancel from INSIDE the retrieval await, which is where the window
    // actually is: the pre-retrieval check has already passed by then, and in
    // production the wait is an FTS read plus an embed against a multi-second
    // budget — now once per retrieving turn (#5 2/3-b), against a Ctrl-C that
    // is ordinary rather than exceptional in a REPL. Throwing afterwards is
    // what a cancelled embed does; retrieval degrades to FTS and still returns
    // content, which is the point — the content is ready and nobody will see it.
    const contextEmbedder: Embedder = {
      model: "test-embed",
      embed: async () => {
        controller.abort();
        throw new Error("cancelled");
      },
    };
    const turn: TurnQuery = { query: "zephyr", turnId: "turn-1" };
    const { kernel, rendered } = harness({ readQuery: () => turn, contextEmbedder });
    const messages = ["one"];
    const reinforce = vi.spyOn(memoryRetrievalService, "reinforceInjectedMemories");

    try {
      await expect(kernel.transformContext(messages, controller.signal)).resolves.toEqual(messages);
      // Nothing reached the model, so nothing claims it did: no render, no
      // access stamp on the CLS ranking inputs (mori#176), no event.
      expect(rendered).toEqual([]);
      expect(reinforce).not.toHaveBeenCalled();
      const events = await readEvents(projectId);
      expect(events.filter((event) => event.type === "memory.injected")).toEqual([]);
    } finally {
      reinforce.mockRestore();
    }

    // …and the cancelled turn took nothing from the turns after it. The same
    // ask, unchanged, still retrieves (the attempt was refunded) and still
    // injects (nothing entered the suppression set) — without both, content the
    // model never saw would stay suppressed for the life of the process.
    const next = await kernel.transformContext(messages);
    expect(injectedCount(next)).toBe(1);
    expect(next[0]).toContain("zephyr pipeline");
  });
});

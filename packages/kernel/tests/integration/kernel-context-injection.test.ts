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

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProject } from "../../src/domain/entities.js";
import {
  observedShell,
  SqliteMemoryKernel,
  type ObservedToolCall,
} from "../../src/kernel/sqlite-memory-kernel.js";
import { renderMemoryContext } from "../../src/services/context-render.js";
import { buildMemoryContext, type MemoryContext } from "../../src/services/context-service.js";
import { rebuildProjectProjection } from "../../src/services/projection-store.js";
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
});

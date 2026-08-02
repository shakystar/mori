import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ConsolidatorLlm, Embedder } from "../../src/index.js";
import {
  observedShell,
  observedWrite,
  SqliteMemoryKernel,
  type ObservedToolCall,
  type SqliteMemoryKernelOptions,
} from "../../src/kernel/sqlite-memory-kernel.js";
import { readLastConsolidateAttempt } from "../../src/services/consolidate-service.js";
import { listValidMemories, listRecentObservations } from "../../src/services/projection-store.js";
import { closeAll } from "../../src/storage/db.js";
import { readEvents } from "../../src/storage/event-store.js";
import { getProjectDbFile } from "../../src/storage/path-resolver.js";

/** The kernel's `E` in these tests: a tool call the harness already classified. */
type FakeEvent = ObservedToolCall | { chatter: true };

let sandbox: string;
const projectId = "proj_kernel_seam_test";

/** An `Embedder` that records every call, so "capture never embeds" is checkable. */
function recordingEmbedder(): { embedder: Embedder; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    embedder: {
      model: "recording",
      async embed(texts: string[]): Promise<number[][]> {
        calls.push("embed");
        return texts.map(() => [0]);
      },
    },
  };
}

function kernelFor(
  options: Partial<SqliteMemoryKernelOptions<string, FakeEvent>> = {},
): SqliteMemoryKernel<string, FakeEvent> {
  return new SqliteMemoryKernel<string, FakeEvent>({
    projectId,
    actor: "mori",
    project: { title: "kernel seam", rootPath: sandbox },
    observeEvent: (event) => ("chatter" in event ? undefined : event),
    ...options,
  });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-kernel-seam-"));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe("SqliteMemoryKernel.observe", () => {
  it("bootstraps the store and appends one observation for a captured tool call", async () => {
    const kernel = kernelFor();

    kernel.observe(observedWrite({ toolName: "edit_file", filePath: "src/index.ts" }));
    await kernel.drain();

    const types = (await readEvents(projectId)).map((event) => event.type);
    expect(types).toEqual(["project.created", "observation.captured"]);

    const [observation] = listRecentObservations(projectId, { limit: 10 });
    expect(observation?.signal).toBe("write-tool");
    expect(observation?.filePath).toBe("src/index.ts");
  });

  it("mints the genesis event only once across many captures", async () => {
    const kernel = kernelFor();

    kernel.observe(observedShell({ toolName: "bash", command: 'git commit -m "one"' }));
    kernel.observe(observedShell({ toolName: "bash", command: 'git commit -m "two"' }));
    await kernel.drain();

    const types = (await readEvents(projectId)).map((event) => event.type);
    expect(types.filter((type) => type === "project.created")).toHaveLength(1);
    expect(types.filter((type) => type === "observation.captured")).toHaveLength(2);
  });

  it("returns before any of the store exists, and never reaches the embedder", async () => {
    const { embedder, calls } = recordingEmbedder();
    const kernel = kernelFor({ embedder });

    kernel.observe(observedShell({ toolName: "bash", command: 'git commit -m "wip"' }));

    // Synchronous and non-blocking: the append cannot have happened yet, because
    // `observe` returned without awaiting it.
    expect(existsSync(getProjectDbFile(projectId))).toBe(false);

    await kernel.drain();
    expect(existsSync(getProjectDbFile(projectId))).toBe(true);
    // The seams that cost network/LLM time are consolidation's, never capture's —
    // the extraction LLM is not even reachable from here, it is a `consolidate`
    // parameter rather than kernel state.
    expect(calls).toEqual([]);
  });

  it("leaves no store on disk when the filter rejects every observed call", async () => {
    const kernel = kernelFor();

    kernel.observe(observedShell({ toolName: "bash", command: "git status" }));
    kernel.observe(observedWrite({ toolName: "read_file", filePath: "src/index.ts" }));
    kernel.observe({ chatter: true });
    await kernel.drain();

    expect(existsSync(getProjectDbFile(projectId))).toBe(false);
  });

  it("reports a failing capture instead of throwing into the loop", async () => {
    const errors: unknown[] = [];
    // No genesis metadata and an empty store: the capture cannot be persisted.
    const kernel = new SqliteMemoryKernel<string, FakeEvent>({
      projectId,
      actor: "mori",
      observeEvent: (event) => ("chatter" in event ? undefined : event),
      onCaptureError: (error) => errors.push(error),
    });

    expect(() =>
      kernel.observe(observedShell({ toolName: "bash", command: 'git commit -m "wip"' })),
    ).not.toThrow();
    await expect(kernel.drain()).resolves.toBeUndefined();

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("no project.created event");
  });
});

describe("SqliteMemoryKernel.consolidate", () => {
  it("distills the observed window into memory with only a ConsolidatorLlm injected", async () => {
    const prompts: string[] = [];
    const llm: ConsolidatorLlm = {
      async complete(prompt: string): Promise<string> {
        prompts.push(prompt);
        return JSON.stringify([
          { kind: "decision", text: "sqlite 커널을 기본 배선으로 쓴다", salience: 7 },
        ]);
      },
    };
    const kernel = kernelFor();

    kernel.observe(observedShell({ toolName: "bash", command: "결정: sqlite 커널로 간다" }));
    await kernel.consolidate(llm);

    expect(prompts).toHaveLength(1);
    const memories = listValidMemories(projectId).map((row) => row.memory.text);
    expect(memories).toEqual(["sqlite 커널을 기본 배선으로 쓴다"]);
  });

  it("consolidates captures that observe() had not yet flushed", async () => {
    const llm: ConsolidatorLlm = {
      async complete(prompt: string): Promise<string> {
        // The observation must already be inside the boundary's window.
        expect(prompt).toContain("git commit");
        return "[]";
      },
    };
    const kernel = kernelFor();

    // Deliberately NOT drained first — consolidate() has to do it.
    kernel.observe(observedShell({ toolName: "bash", command: 'git commit -m "wip"' }));
    const result = await kernel.consolidateWithResult(llm);

    expect(result.observationsProcessed).toBe(1);
    expect(result.extractor).toBe("llm");
  });

  describe("boundary labels (#141)", () => {
    const llm: ConsolidatorLlm = {
      async complete() {
        return "[]";
      },
    };

    it("records a different boundary label per call on the same kernel instance", async () => {
      // No `boundary` fixed at construction — this is the shape a fixed, instance-level
      // label could never pass: the SAME instance must be able to serve both triggers.
      const kernel = kernelFor();

      kernel.observe(observedShell({ toolName: "bash", command: "git commit -m one" }));
      await kernel.consolidate(llm, { boundary: "session-end" });
      expect(readLastConsolidateAttempt(projectId)?.boundary).toBe("session-end");

      kernel.observe(observedShell({ toolName: "bash", command: "git commit -m two" }));
      await kernel.consolidate(llm, { boundary: "manual" });
      expect(readLastConsolidateAttempt(projectId)?.boundary).toBe("manual");
    });

    it("prefers the per-call boundary over the one fixed at construction", async () => {
      // `options.boundary` is a fallback ONLY — a construction-time label must not win over
      // a call that names its own.
      const kernel = kernelFor({ boundary: "post-compact" });

      kernel.observe(observedShell({ toolName: "bash", command: "git commit -m one" }));
      await kernel.consolidate(llm);
      expect(readLastConsolidateAttempt(projectId)?.boundary).toBe("post-compact");

      kernel.observe(observedShell({ toolName: "bash", command: "git commit -m two" }));
      await kernel.consolidate(llm, { boundary: "manual" });
      expect(readLastConsolidateAttempt(projectId)?.boundary).toBe("manual");
    });
  });
});

describe("SqliteMemoryKernel.transformContext", () => {
  it("passes messages through untouched without a `renderContext` seam", async () => {
    // Session-start injection needs the harness to say what a message is; the
    // rest of its contract lives in kernel-context-injection.test.ts.
    const messages = ["one", "two"];

    await expect(kernelFor().transformContext(messages)).resolves.toEqual(messages);
  });
});

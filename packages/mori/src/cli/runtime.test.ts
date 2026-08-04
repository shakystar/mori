import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ConsolidatorLlm } from "@mori/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMoriKernel, moriProjectId, moriStoreExistsForId } from "../kernel/index.js";
import { sessionEndLlm } from "./runtime.js";

function toolStart(toolCallId: string, toolName: string, args: unknown): AgentEvent {
  return { type: "tool_execution_start", toolCallId, toolName, args };
}

function toolEnd(toolCallId: string, toolName: string): AgentEvent {
  return {
    type: "tool_execution_end",
    toolCallId,
    toolName,
    result: { details: { ok: true } },
    isError: false,
  };
}

const stubLlm: ConsolidatorLlm = {
  async complete() {
    return "[]";
  },
};

describe("sessionEndLlm (#230)", () => {
  let root: string;
  let store: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "mori-runtime-root-")));
    store = realpathSync(mkdtempSync(join(tmpdir(), "mori-runtime-store-")));
    process.env.MEMORIZE_ROOT = store;
  });

  afterEach(() => {
    delete process.env.MEMORIZE_ROOT;
    rmSync(root, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });

  it("checks the store for the kernel's construction-time id, not a fresh re-read of .mori/project.json (#230)", async () => {
    const kernel = createMoriKernel({ root, env: {} });
    const observe = kernel.observe.bind(kernel);

    // A real observation against the id the kernel actually resolved — the same
    // path a captured edit_file/bash call takes in production (kernel/index.ts's
    // createAgentEventObserver), so the store this test checks is genuine.
    observe(toolStart("c1", "edit_file", { path: "notes.md", oldString: "", newString: "x" }));
    observe(toolEnd("c1", "edit_file"));
    await kernel.drain();
    expect(moriStoreExistsForId(kernel.projectId)).toBe(true);

    // Simulate exactly the scenario #230 is about: something (a `git checkout`, another
    // mori session's `persistProjectIdentity`, this fleet's own worktree-per-issue switch)
    // replaces `.mori/project.json` with a DIFFERENT valid id after the kernel already
    // captured under its own. A fresh `moriProjectId(root)` now disagrees with the kernel.
    const swappedId = "proj_deadbeefdeadbeef";
    writeFileSync(join(root, ".mori", "project.json"), `${JSON.stringify({ id: swappedId })}\n`);
    expect(moriProjectId(root)).toBe(swappedId);
    expect(moriProjectId(root)).not.toBe(kernel.projectId);
    // The swapped id's store was never created — re-deriving identity at session-end
    // time (the pre-#230 bug) would check THIS nonexistent store and skip the boundary.
    expect(moriStoreExistsForId(swappedId)).toBe(false);

    // The fix: sessionEndLlm reads the id back from where the kernel construction
    // pinned it (prepareAgent's `projectId`), so the boundary is judged against the
    // store this session actually captured into and is not skipped.
    expect(sessionEndLlm(stubLlm, kernel.projectId)).toBe(stubLlm);
  });
});

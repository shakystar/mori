import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { ConsolidatorLlm } from "@mori/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consolidateOnSessionEnd } from "../cli/consolidation.js";
import { runCli } from "../index.js";
import { createMoriTools } from "../tools/index.js";
import {
  createAgentEventObserver,
  createMoriKernel,
  moriProjectId,
  toolCaptureVerdict,
} from "./index.js";

const USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type FakeTurn =
  { toolCall: { name: string; arguments: Record<string, unknown> } } | { text: string };

/** Plays back one scripted turn per model call: a tool call, then a final answer. */
function scriptedStreamFn(turns: FakeTurn[]): StreamFn {
  let call = 0;
  return (model) => {
    const turn = turns[call] ?? turns.at(-1)!;
    call++;
    const stream = createAssistantMessageEventStream();
    const base = {
      role: "assistant" as const,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: USAGE,
      timestamp: 0,
    };
    const message: AssistantMessage =
      "toolCall" in turn
        ? {
            ...base,
            content: [
              {
                type: "toolCall",
                id: `call-${call}`,
                name: turn.toolCall.name,
                arguments: turn.toolCall.arguments,
              } satisfies ToolCall,
            ],
            stopReason: "toolUse",
          }
        : { ...base, content: [{ type: "text", text: turn.text }], stopReason: "stop" };

    stream.push({ type: "start", partial: message } satisfies AssistantMessageEvent);
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    } satisfies AssistantMessageEvent);
    return stream;
  };
}

function toolStart(toolCallId: string, toolName: string, args: unknown): AgentEvent {
  return { type: "tool_execution_start", toolCallId, toolName, args };
}

/**
 * Defaults to a structurally successful result shaped like the real tool it
 * names (`bash`'s success also needs `exitCode`/`timedOut`, see #129) so tests
 * that aren't exercising the success/failure distinction don't have to spell
 * it out. Pass `details` to test a specific structured outcome instead.
 */
function toolEnd(
  toolCallId: string,
  toolName: string,
  options: { isError?: boolean; details?: unknown } = {},
): AgentEvent {
  const details =
    options.details ??
    (toolName === "bash" ? { ok: true, exitCode: 0, timedOut: false } : { ok: true });
  return {
    type: "tool_execution_end",
    toolCallId,
    toolName,
    result: { details },
    isError: options.isError ?? false,
  };
}

describe("moriProjectId", () => {
  it("is stable for one root and distinct across roots", () => {
    expect(moriProjectId("/repos/mori")).toBe(moriProjectId("/repos/mori/"));
    expect(moriProjectId("/repos/mori")).not.toBe(moriProjectId("/repos/other"));
    // It is also a directory name, so it must satisfy the kernel's id pattern.
    expect(moriProjectId("/repos/mori")).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/);
  });
});

describe("tool capture coverage", () => {
  it("classifies every tool mori registers", () => {
    // Drift guard: a new tool that ships without a verdict is invisible to memory.
    const unclassified = createMoriTools("/tmp")
      .map((tool) => tool.name)
      .filter((name) => toolCaptureVerdict(name) === undefined);

    expect(unclassified).toEqual([]);
  });
});

describe("createAgentEventObserver", () => {
  it("reports an edit_file call as its path alone, never the replacement text", () => {
    const observe = createAgentEventObserver();
    const args = { path: "src/index.ts", oldString: "a", newString: "b" };

    expect(observe(toolStart("c1", "edit_file", args))).toBeUndefined();
    const observed = observe(toolEnd("c1", "edit_file"));

    expect(observed).toEqual({ toolName: "edit_file", toolInputText: "src/index.ts" });
  });

  it("reports a bash call as its command text", () => {
    const observe = createAgentEventObserver();

    observe(toolStart("c1", "bash", { command: "git commit -m wip", timeoutMs: 1000 }));

    expect(observe(toolEnd("c1", "bash"))).toEqual({
      toolName: "bash",
      toolInputText: "git commit -m wip",
    });
  });

  it("ignores a tool call that failed — nothing changed, so it is no work signal", () => {
    const observe = createAgentEventObserver();

    observe(toolStart("c1", "bash", { command: "git commit -m wip" }));

    expect(observe(toolEnd("c1", "bash", { isError: true }))).toBeUndefined();
  });

  it("ignores a structurally-failed edit_file even though isError is false (#129)", () => {
    // mori's tools never throw: a failed edit_file reports { ok: false, reason }
    // as an ordinary, non-error result (tool-result.ts's errorResult).
    const observe = createAgentEventObserver();

    observe(toolStart("c1", "edit_file", { path: "src/index.ts", oldString: "a", newString: "b" }));

    expect(
      observe(
        toolEnd("c1", "edit_file", {
          details: { ok: false, reason: "oldString not found in file: src/index.ts" },
        }),
      ),
    ).toBeUndefined();
  });

  it("ignores a bash call that ran but exited non-zero, even though isError is false (#129)", () => {
    // runBash reports a failed command as { ok: true, exitCode: 1, ... } — the
    // process itself started and ended fine, only the command failed.
    const observe = createAgentEventObserver();

    observe(toolStart("c1", "bash", { command: "git commit -m wip" }));

    expect(
      observe(
        toolEnd("c1", "bash", {
          details: { ok: true, exitCode: 1, timedOut: false },
        }),
      ),
    ).toBeUndefined();
  });

  it("ignores a bash call that timed out, even though isError is false and exitCode is null (#129)", () => {
    const observe = createAgentEventObserver();

    observe(toolStart("c1", "bash", { command: "sleep 999" }));

    expect(
      observe(
        toolEnd("c1", "bash", {
          details: { ok: true, exitCode: null, timedOut: true },
        }),
      ),
    ).toBeUndefined();
  });

  it("ignores a bash call killed by a signal (exitCode null, not a timeout) (#129)", () => {
    const observe = createAgentEventObserver();

    observe(toolStart("c1", "bash", { command: "long-running-thing" }));

    expect(
      observe(
        toolEnd("c1", "bash", {
          details: { ok: true, exitCode: null, signal: "SIGTERM", timedOut: false },
        }),
      ),
    ).toBeUndefined();
  });

  it("ignores read-only tools", () => {
    const observe = createAgentEventObserver();

    observe(toolStart("c1", "read_file", { path: "src/index.ts" }));

    expect(observe(toolEnd("c1", "read_file"))).toBeUndefined();
  });

  it("forgets arguments of calls that never ended, so an aborted run leaks nothing", () => {
    const observe = createAgentEventObserver();

    observe(toolStart("c1", "bash", { command: "git commit -m wip" }));
    observe({ type: "agent_end", messages: [] });

    // The end event arrives with no arguments of its own; without the remembered
    // ones there is nothing to capture.
    expect(observe(toolEnd("c1", "bash"))).toBeUndefined();
  });

  it("ignores a write call whose arguments carry no path", () => {
    const observe = createAgentEventObserver();

    observe(toolStart("c1", "edit_file", { oldString: "a", newString: "b" }));

    expect(observe(toolEnd("c1", "edit_file"))).toBeUndefined();
  });

  it("ignores a shell call whose arguments carry no command", () => {
    const observe = createAgentEventObserver();

    observe(toolStart("c1", "bash", { timeoutMs: 1000 }));

    expect(observe(toolEnd("c1", "bash"))).toBeUndefined();
  });

  it("keeps concurrent calls of the same tool apart, keyed by their own tool-call id", () => {
    const observe = createAgentEventObserver();

    observe(toolStart("c1", "edit_file", { path: "a.ts" }));
    observe(toolStart("c2", "edit_file", { path: "b.ts" }));

    // c2 ends first: if pending were keyed by toolName instead of toolCallId,
    // c1 would resolve to "b.ts" too.
    expect(observe(toolEnd("c2", "edit_file"))).toEqual({
      toolName: "edit_file",
      toolInputText: "b.ts",
    });
    expect(observe(toolEnd("c1", "edit_file"))).toEqual({
      toolName: "edit_file",
      toolInputText: "a.ts",
    });
  });

  it("keeps concurrent calls of different tools apart without cross-family interference", () => {
    const observe = createAgentEventObserver();

    observe(toolStart("c1", "edit_file", { path: "a.ts" }));
    observe(toolStart("c2", "bash", { command: "pnpm test" }));

    // c2 ends first: c1's remembered path must not have been touched or dropped.
    expect(observe(toolEnd("c2", "bash"))).toEqual({
      toolName: "bash",
      toolInputText: "pnpm test",
    });
    expect(observe(toolEnd("c1", "edit_file"))).toEqual({
      toolName: "edit_file",
      toolInputText: "a.ts",
    });
  });
});

describe("mori turn -> sqlite store", () => {
  let root: string;
  let store: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "mori-kernel-root-")));
    store = realpathSync(mkdtempSync(join(tmpdir(), "mori-kernel-store-")));
    // The kernel's path resolver reads MEMORIZE_ROOT from process.env directly
    // (storage/path-resolver.ts), so redirecting the store means setting it here.
    process.env.MEMORIZE_ROOT = store;
  });

  afterEach(() => {
    delete process.env.MEMORIZE_ROOT;
    rmSync(root, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });

  /** One real `mori "…"` invocation: nothing about the kernel is substituted. */
  async function run(turns: FakeTurn[], env: NodeJS.ProcessEnv = {}): Promise<number> {
    return runCli(
      ["한 턴만"],
      { ANTHROPIC_API_KEY: "sk-ant-test", ...env },
      {
        stdout: () => {},
        stderr: () => {},
        credentialStore: new InMemoryCredentialStore(),
        streamFn: scriptedStreamFn(turns),
        root,
      },
    );
  }

  it("lands one turn's file edit in the store as a consolidatable observation", async () => {
    const exitCode = await run([
      {
        toolCall: {
          name: "edit_file",
          arguments: { path: "notes.md", oldString: "", newString: "기억은 커널이 남긴다\n" },
        },
      },
      { text: "만들었습니다" },
    ]);

    expect(exitCode).toBe(0);
    // The tool really ran, so this was a real turn and not a scripted no-op.
    expect(readFileSync(join(root, "notes.md"), "utf8")).toContain("기억은 커널이 남긴다");
    // `runCli` settled its kernel before returning, so the store is already there —
    // which is what keeps a one-shot `mori "…"` from losing the turn to process exit.
    expect(readdirSync(store)).toContain("projects");

    // Read the log back through the only surface the harness has: a boundary over
    // the observation events appended since the last one. A second kernel on the
    // same working root addresses the same store, which is what makes the store
    // (not the instance) the thing under test.
    const prompts: string[] = [];
    const llm: ConsolidatorLlm = {
      async complete(prompt: string): Promise<string> {
        prompts.push(prompt);
        return "[]";
      },
    };
    const result = await createMoriKernel({ root, env: {} }).consolidateWithResult(llm);

    expect(result.observationsProcessed).toBe(1);
    expect(prompts[0]).toContain("notes.md");
  });

  it("lands one turn's bash call in the store as a consolidatable observation", async () => {
    const exitCode = await run([
      // Not itself a capture signal (evaluateCapture's mutating-bash pattern doesn't match
      // plain redirection) — it only sets up the file the next call renames.
      { toolCall: { name: "bash", arguments: { command: "echo 기억은 커널이 남긴다 > src.txt" } } },
      // `mv` matches MUTATING_BASH_PATTERN (capture-service.ts), so this is the call the
      // observer and the capture filter both have to let through end to end.
      { toolCall: { name: "bash", arguments: { command: "mv src.txt shell-notes.txt" } } },
      { text: "실행했습니다" },
    ]);

    expect(exitCode).toBe(0);
    // The commands really ran, so this was a real turn and not a scripted no-op.
    expect(readFileSync(join(root, "shell-notes.txt"), "utf8")).toContain("기억은 커널이 남긴다");
    // `runCli` settled its kernel before returning — same non-blocking drain guarantee
    // edit_file's turn above relies on, exercised here through the `bash` capture family.
    expect(readdirSync(store)).toContain("projects");

    const prompts: string[] = [];
    const llm: ConsolidatorLlm = {
      async complete(prompt: string): Promise<string> {
        prompts.push(prompt);
        return "[]";
      },
    };
    const result = await createMoriKernel({ root, env: {} }).consolidateWithResult(llm);

    // Exactly one observation: the `echo` redirect never passed the capture filter, so
    // only the `mv` call reached the store.
    expect(result.observationsProcessed).toBe(1);
    expect(prompts[0]).toContain("mv src.txt shell-notes.txt");
  });

  it("the session-end trigger (#107) lands a real boundary's memories in the event log", async () => {
    const exitCode = await run([
      {
        toolCall: {
          name: "edit_file",
          arguments: { path: "notes.md", oldString: "", newString: "세션 종료가 증류를 부른다\n" },
        },
      },
      { text: "만들었습니다" },
    ]);
    expect(exitCode).toBe(0);

    const prompts: string[] = [];
    const llm: ConsolidatorLlm = {
      async complete(prompt: string): Promise<string> {
        prompts.push(prompt);
        return "[]";
      },
    };
    const errors: string[] = [];
    const kernel = createMoriKernel({ root, env: {} });

    await consolidateOnSessionEnd(kernel, llm, (message) => errors.push(message));

    expect(errors).toEqual([]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("notes.md");

    // Read the boundary's own outcome back through a second call: the watermark this trigger
    // advanced means a second real boundary over the same window finds nothing left to do.
    const second = await kernel.consolidateWithResult(llm);
    expect(second.outcome).toBe("noop");
  });

  it("writes nothing at all for a turn that only reads", async () => {
    const exitCode = await run([
      { toolCall: { name: "list_dir", arguments: { path: "." } } },
      { text: "빈 디렉터리입니다" },
    ]);

    expect(exitCode).toBe(0);
    expect(readdirSync(store)).toEqual([]);
  });

  it("writes nothing at all for a read-only turn even with consolidation configured (#107 review)", async () => {
    // Sibling of the case above, with MORI_CONSOLIDATE_MODEL set: the session-end trigger
    // must not be the thing that creates the store for a session that captured nothing.
    const exitCode = await run(
      [{ toolCall: { name: "list_dir", arguments: { path: "." } } }, { text: "빈 디렉터리입니다" }],
      { MORI_CONSOLIDATE_MODEL: "anthropic/claude-x" },
    );

    expect(exitCode).toBe(0);
    expect(readdirSync(store)).toEqual([]);
  });
});

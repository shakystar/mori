import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BENCH_AXES } from "./axes.js";
import type { LlmCallCacheStore } from "./cache/llm-call-cache.js";
import { createCostLedger } from "./cost-ledger.js";
import { createReader, resolveReaderCwd, resolveReaderExecutionPath } from "./reader.js";

function model(): Model<Api> {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function fakeStreamFn(text: string): StreamFn & { calls: Context[] } {
  const calls: Context[] = [];
  const fn = async (_model: Model<Api>, context: Context) => {
    calls.push(context);
    const message = assistantMessage(text);
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    return stream;
  };
  Object.defineProperty(fn, "calls", { get: () => calls });
  return fn as unknown as StreamFn & { calls: Context[] };
}

class InMemoryStore implements LlmCallCacheStore {
  private readonly entries = new Map<string, AssistantMessage>();
  async get(key: string) {
    return this.entries.get(key);
  }
  async set(key: string, message: AssistantMessage) {
    this.entries.set(key, message);
  }
}

interface FakeSpawnCall {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

function fakeSpawn(result: { exitCode?: number; stdout?: string; stderr?: string }, calls: FakeSpawnCall[]) {
  return ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args: [...args], options });
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    Object.assign(child, { stdout, stderr });
    queueMicrotask(() => {
      if (result.stdout) stdout.emit("data", Buffer.from(result.stdout));
      if (result.stderr) stderr.emit("data", Buffer.from(result.stderr));
      child.emit("close", result.exitCode ?? 0);
    });
    return child;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

describe("resolveReaderExecutionPath", () => {
  it("defaults to api when unset", () => {
    expect(resolveReaderExecutionPath({})).toBe("api");
  });

  it("reads MORI_BENCH_READER_PATH=claude-cli", () => {
    expect(resolveReaderExecutionPath({ MORI_BENCH_READER_PATH: "claude-cli" })).toBe("claude-cli");
  });

  it("throws loudly on an unknown value instead of silently falling back", () => {
    expect(() => resolveReaderExecutionPath({ MORI_BENCH_READER_PATH: "batch" })).toThrow(/알 수 없는/);
  });
});

describe("resolveReaderCwd", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mori-bench-reader-cwd-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("defaults to a neutral temp directory, not the repo root", async () => {
    const cwd = await resolveReaderCwd();
    expect(cwd).not.toBe(process.cwd());
    expect(cwd.startsWith(tmpdir())).toBe(true);
  });

  it("honors an explicit cwd that has no CLAUDE.md", async () => {
    expect(await resolveReaderCwd(dir)).toBe(dir);
  });

  it("refuses an explicit cwd with a CLAUDE.md instead of silently contaminating the run", async () => {
    await writeFile(join(dir, "CLAUDE.md"), "# instructions");
    await expect(resolveReaderCwd(dir)).rejects.toThrow(/CLAUDE\.md/);
  });
});

describe("createReader path selection", () => {
  it('"api" path calls streamFn and never spawns a subprocess', async () => {
    const streamFn = fakeStreamFn("api reply");
    const spawnCalls: FakeSpawnCall[] = [];
    const reader = await createReader({
      path: "api",
      api: { model: model(), streamFn, cacheStore: new InMemoryStore() },
      claudeCli: { spawn: fakeSpawn({ stdout: "unused" }, spawnCalls) },
    });

    const result = await reader.read("hello");

    expect(result.text).toBe("api reply");
    expect(streamFn.calls).toHaveLength(1);
    expect(spawnCalls).toHaveLength(0);
  });

  it('"claude-cli" path spawns `claude -p` and never calls streamFn', async () => {
    const streamFn = fakeStreamFn("api reply");
    const spawnCalls: FakeSpawnCall[] = [];
    const dir = await mkdtemp(join(tmpdir(), "mori-bench-reader-cli-"));
    try {
      const reader = await createReader({
        path: "claude-cli",
        api: { model: model(), streamFn, cacheStore: new InMemoryStore() },
        claudeCli: { cwd: dir, spawn: fakeSpawn({ stdout: "cli reply\n" }, spawnCalls) },
      });

      const result = await reader.read("hello");

      expect(result.text).toBe("cli reply");
      expect(streamFn.calls).toHaveLength(0);
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]?.args).toEqual(["-p", "hello"]);
      expect(spawnCalls[0]?.options.cwd).toBe(dir);
      expect(spawnCalls[0]?.options.cwd).not.toBe(process.cwd());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('"claude-cli" path rejects when the subprocess exits non-zero', async () => {
    const spawnCalls: FakeSpawnCall[] = [];
    const dir = await mkdtemp(join(tmpdir(), "mori-bench-reader-cli-fail-"));
    try {
      const reader = await createReader({
        path: "claude-cli",
        claudeCli: { cwd: dir, spawn: fakeSpawn({ exitCode: 1, stderr: "boom" }, spawnCalls) },
      });

      await expect(reader.read("hello")).rejects.toThrow(/boom/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("api reader cache + cost integration", () => {
  it("caches replies and records usage into the cost ledger under the given axis", async () => {
    const streamFn = fakeStreamFn("api reply");
    const store = new InMemoryStore();
    const costLedger = createCostLedger();

    const reader = await createReader({
      path: "api",
      api: {
        model: model(),
        streamFn,
        cacheStore: store,
        costLedger,
        costAxis: BENCH_AXES.injectionHitRate,
      },
    });

    await reader.read("same prompt");
    await reader.read("same prompt");

    expect(streamFn.calls).toHaveLength(1);
    const report = costLedger.report();
    expect(report.byAxis[BENCH_AXES.injectionHitRate]?.totalTokens).toBe(30);
    expect(report.byAxis[BENCH_AXES.cost]).toBeUndefined();
  });
});

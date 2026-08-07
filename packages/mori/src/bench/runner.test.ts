import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BENCH_AXES } from "./axes.js";
import { createBenchRunner } from "./runner.js";

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

/** Responds deterministically to any prompt — the cache key already varies with the prompt
 * (folded into `Context`), so a fixed reply is enough to prove call counts without needing
 * per-prompt branching here. */
function fakeStreamFn(): StreamFn & { calls: number } {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "reply" }],
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
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    return stream;
  };
  Object.defineProperty(fn, "calls", { get: () => calls });
  return fn as unknown as StreamFn & { calls: number };
}

describe("createBenchRunner", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "mori-bench-runner-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("replays a 2-turn run with zero real API calls the second time (onHit/onMiss counters)", async () => {
    const firstStreamFn = fakeStreamFn();
    const firstHits: string[] = [];
    const firstMisses: string[] = [];
    const runner1 = await createBenchRunner({
      cacheDir,
      model: model(),
      streamFn: firstStreamFn,
      readerPath: "api",
      cacheHooks: {
        onHit: (key) => firstHits.push(key),
        onMiss: (key) => firstMisses.push(key),
      },
    });
    await runner1.reader.read("turn 1");
    await runner1.reader.read("turn 2");
    expect(firstStreamFn.calls).toBe(2);
    expect(firstMisses).toHaveLength(2);
    expect(firstHits).toHaveLength(0);

    // A second run against the same cache dir — as if the bench were replayed end to end.
    const secondStreamFn = fakeStreamFn();
    const secondHits: string[] = [];
    const secondMisses: string[] = [];
    const runner2 = await createBenchRunner({
      cacheDir,
      model: model(),
      streamFn: secondStreamFn,
      readerPath: "api",
      cacheHooks: {
        onHit: (key) => secondHits.push(key),
        onMiss: (key) => secondMisses.push(key),
      },
    });
    await runner2.reader.read("turn 1");
    await runner2.reader.read("turn 2");

    // Completion condition: the second execution makes zero real provider calls.
    expect(secondStreamFn.calls).toBe(0);
    expect(secondHits).toHaveLength(2);
    expect(secondMisses).toHaveLength(0);
  });

  it("records reader usage into the cost ledger and persists it via #373's writeCostReport", async () => {
    const streamFn = fakeStreamFn();
    const runner = await createBenchRunner({
      cacheDir,
      model: model(),
      streamFn,
      readerPath: "api",
    });

    await runner.reader.read("turn 1");
    await runner.reader.read("turn 2");

    const reportPath = join(cacheDir, "..", "cost-report.json");
    const report = await runner.finish(reportPath);

    expect(report.byAxis[BENCH_AXES.cost]?.totalTokens).toBe(30);
    expect(report.total.totalTokens).toBe(30);

    const persisted = JSON.parse(await readFile(reportPath, "utf8")) as typeof report;
    expect(persisted).toEqual(report);

    await rm(reportPath, { force: true });
  });

  it("sweeps orphan .tmp-<uuid> cache files at startup before the cache is used", async () => {
    await writeFile(join(cacheDir, "stale.json.tmp-11111111-1111-4a11-8a11-000000000001"), "{}");

    await createBenchRunner({ cacheDir, model: model(), streamFn: fakeStreamFn(), readerPath: "api" });

    expect(await readdir(cacheDir)).toEqual([]);
  });

  it('routes the "claude-cli" path through spawn, never through streamFn', async () => {
    const streamFn = fakeStreamFn();
    const spawnCalls: Array<{ command: string; args: string[]; cwd: unknown }> = [];
    const cliDir = await mkdtemp(join(tmpdir(), "mori-bench-runner-cli-"));
    try {
      const fakeSpawn = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
        spawnCalls.push({ command, args: [...args], cwd: options.cwd });
        const child = new EventEmitter() as unknown as ChildProcess;
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        Object.assign(child, { stdout, stderr });
        queueMicrotask(() => {
          stdout.emit("data", Buffer.from("cli reply"));
          child.emit("close", 0);
        });
        return child;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;

      const runner = await createBenchRunner({
        cacheDir,
        model: model(),
        streamFn,
        readerPath: "claude-cli",
        claudeCliCwd: cliDir,
        claudeCliSpawn: fakeSpawn,
      });

      const result = await runner.reader.read("hello");

      expect(result.text).toBe("cli reply");
      expect(streamFn.calls).toBe(0);
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]?.cwd).toBe(cliDir);
    } finally {
      await rm(cliDir, { recursive: true, force: true });
    }
  });

  it("defaults the reader path from MORI_BENCH_READER_PATH when readerPath is not given", async () => {
    const streamFn = fakeStreamFn();
    const cliDir = await mkdtemp(join(tmpdir(), "mori-bench-runner-env-"));
    try {
      const spawnCalls: unknown[] = [];
      const fakeSpawn = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
        spawnCalls.push({ command, args, options });
        const child = new EventEmitter() as unknown as ChildProcess;
        const stdout = new EventEmitter();
        Object.assign(child, { stdout, stderr: new EventEmitter() });
        queueMicrotask(() => {
          stdout.emit("data", Buffer.from("cli reply"));
          child.emit("close", 0);
        });
        return child;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;

      const runner = await createBenchRunner(
        { cacheDir, model: model(), streamFn, claudeCliCwd: cliDir, claudeCliSpawn: fakeSpawn },
        { MORI_BENCH_READER_PATH: "claude-cli" },
      );

      await runner.reader.read("hello");
      expect(streamFn.calls).toBe(0);
      expect(spawnCalls).toHaveLength(1);
    } finally {
      await rm(cliDir, { recursive: true, force: true });
    }
  });
});

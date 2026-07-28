import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BASH_BLOCKED_PATTERNS,
  BASH_STRIPPED_ENV_VARS,
  BASH_TOOL_NAME,
  createBashBeforeToolCall,
  createBashTool,
  runBash,
} from "./bash.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "mori-bash-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Minimal `beforeToolCall` context — the hook only reads `toolCall` and `args`. */
function toolCallContext(name: string, args: unknown): BeforeToolCallContext {
  const toolCall = { type: "toolCall" as const, id: "call-1", name, arguments: args as Record<string, any> };
  const assistantMessage = {
    role: "assistant",
    content: [toolCall],
  } as unknown as AssistantMessage;

  return {
    assistantMessage,
    toolCall,
    args,
    context: { systemPrompt: "", messages: [] },
  };
}

/** True while `pid` exists and is not a zombie. Linux only — reads /proc. */
function isRunning(pid: number): boolean {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return false;
  }
  // Field 3 is the state character; the comm field before it may contain spaces.
  const state = stat.slice(stat.lastIndexOf(")") + 2).trim().charAt(0);
  return state !== "Z" && state !== "X";
}

describe("runBash", () => {
  it("returns stdout and exit code for a successful command", async () => {
    const result = await runBash("echo hi", { root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stdout).toBe("hi\n");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdoutTruncated).toBe(false);
  });

  it("returns a failing exit code as a result instead of throwing", async () => {
    const result = await runBash("echo oops >&2; exit 3", { root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("oops\n");
  });

  it("kills a command that overruns the timeout and reports partial output", async () => {
    const started = Date.now();
    const result = await runBash("echo partial; sleep 30", { root, timeoutMs: 300 });
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe("partial\n");
    expect(elapsed).toBeLessThan(10_000);
  });

  // Linux-only: reads /proc to tell "gone or reaped" from "still running".
  it.skipIf(process.platform !== "linux")(
    "kills background children of a timed-out command, leaving nothing running",
    async () => {
      const result = await runBash("sleep 30 & echo $!; sleep 30", { root, timeoutMs: 300 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.timedOut).toBe(true);

      const backgroundPid = Number(result.stdout.trim());
      expect(Number.isInteger(backgroundPid)).toBe(true);

      // Give the signal a moment to land on the whole process group.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(isRunning(backgroundPid)).toBe(false);
    },
  );

  it("does not hang on a command that reads stdin", async () => {
    const result = await runBash("cat", { root, timeoutMs: 5_000 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it("truncates output past the cap and records that it truncated", async () => {
    const result = await runBash("seq 1 10000", { root, maxOutputChars: 50 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stdout.length).toBe(50);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.startsWith("1\n2\n3\n")).toBe(true);
  });

  it("truncates stderr independently of stdout", async () => {
    const result = await runBash("seq 1 10000 >&2", { root, maxOutputChars: 20 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stderr.length).toBe(20);
    expect(result.stderrTruncated).toBe(true);
    expect(result.stdoutTruncated).toBe(false);
  });

  it("pins the child working directory to the working root", async () => {
    expect(process.cwd()).not.toBe(root);

    const result = await runBash("pwd", { root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stdout.trim()).toBe(root);
  });

  it("resolves relative paths against the working root", async () => {
    writeFileSync(join(root, "marker.txt"), "inside-root\n");

    const result = await runBash("cat marker.txt", { root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stdout).toBe("inside-root\n");
  });

  it("does not pass mori's Anthropic credentials to the child process", async () => {
    const env = { ...process.env, ANTHROPIC_API_KEY: "sk-ant-secret", MORI_KEEP: "kept" };

    const result = await runBash(
      "printenv ANTHROPIC_API_KEY && echo LEAKED || echo ABSENT; printenv MORI_KEEP",
      { root, env },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stdout).not.toContain("sk-ant-secret");
    expect(result.stdout).not.toContain("LEAKED");
    expect(result.stdout).toContain("ABSENT");
    // Unrelated variables are still inherited — this is a scrub, not an empty environment.
    expect(result.stdout).toContain("kept");
  });

  it("strips every variable named in BASH_STRIPPED_ENV_VARS", async () => {
    const env = { ...process.env } as NodeJS.ProcessEnv;
    for (const name of BASH_STRIPPED_ENV_VARS) env[name] = `secret-${name}`;

    const result = await runBash("env", { root, env });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const name of BASH_STRIPPED_ENV_VARS) {
      expect(result.stdout).not.toContain(`${name}=`);
    }
  });

  it("refuses a blocked command without executing it", async () => {
    const result = await runBash("rm -rf /", { root });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockedPatternId).toBe("rm-root");
    expect(result.reason).toContain("rm-root");
  });
});

describe("bash blocklist", () => {
  /** One sample command per blocklist id. Every id must appear here. */
  const samples: Record<string, string[]> = {
    "rm-root": ["rm -rf /", "sudo rm -rf --no-preserve-root /", "rm -r -f /*", "rm -rf ~", "rm -fr $HOME"],
    "rm-no-preserve-root": ["rm -rf --no-preserve-root /tmp/x"],
    "rm-system-directory": ["rm -rf /etc", "rm -rf /usr/lib", "rm -r /boot"],
    "dd-to-disk-device": ["dd if=/dev/zero of=/dev/sda bs=1M", "dd if=x.img of=/dev/nvme0n1"],
    "redirect-to-disk-device": ["cat image.iso > /dev/sdb", "echo x >> /dev/vda"],
    mkfs: ["mkfs.ext4 /dev/sdb1", "mkfs -t ext4 /dev/sdb1"],
    "fork-bomb": [":(){ :|:& };:", "bomb(){ bomb|bomb& }; bomb"],
  };

  it("has a test case for every blocked pattern", () => {
    expect(Object.keys(samples).sort()).toEqual(BASH_BLOCKED_PATTERNS.map((entry) => entry.id).sort());
  });

  for (const entry of BASH_BLOCKED_PATTERNS) {
    describe(entry.id, () => {
      for (const command of samples[entry.id] ?? []) {
        it(`blocks \`${command}\``, async () => {
          const hook = createBashBeforeToolCall();

          const decision = await hook(toolCallContext(BASH_TOOL_NAME, { command }));

          expect(decision?.block).toBe(true);
          expect(decision?.reason).toContain(entry.id);
          expect(decision?.reason).toContain(entry.description);
        });
      }
    });
  }

  it("lets ordinary commands through", async () => {
    const hook = createBashBeforeToolCall();
    const allowed = [
      "echo hi",
      "rm -rf ./dist",
      "rm -rf node_modules",
      "rm -rf /tmp/mori-scratch",
      "ls /",
      "cat /etc/hosts",
      "dd if=/dev/zero of=./blob bs=1 count=1",
      "pnpm test",
    ];

    for (const command of allowed) {
      expect(await hook(toolCallContext(BASH_TOOL_NAME, { command }))).toBeUndefined();
    }
  });

  it("ignores tool calls for other tools", async () => {
    const hook = createBashBeforeToolCall();

    expect(await hook(toolCallContext("read_file", { command: "rm -rf /" }))).toBeUndefined();
  });
});

describe("bash tool", () => {
  it("formats stdout, truncation and exit code into the model-visible result", async () => {
    const tool = createBashTool(root, { maxOutputChars: 20 });

    const result = await tool.execute("call-1", { command: "seq 1 10000" });

    const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    expect(text).toContain("[stdout truncated at 20 characters]");
    expect(text).toContain("[exit code 0]");
    expect(result.details.ok).toBe(true);
  });

  it("clamps a model-requested timeout to the configured maximum", async () => {
    const tool = createBashTool(root, { timeoutMs: 300 });

    const result = await tool.execute("call-1", { command: "sleep 30", timeoutMs: 60_000 });

    expect(result.details.ok).toBe(true);
    if (!result.details.ok) return;
    expect(result.details.timeoutMs).toBe(300);
    expect(result.details.timedOut).toBe(true);
  });

  it("honours a shorter model-requested timeout", async () => {
    const tool = createBashTool(root, { timeoutMs: 60_000 });

    const result = await tool.execute("call-1", { command: "sleep 30", timeoutMs: 300 });

    expect(result.details.ok).toBe(true);
    if (!result.details.ok) return;
    expect(result.details.timeoutMs).toBe(300);
    expect(result.details.timedOut).toBe(true);
  });

  it("reports a timeout in the model-visible result", async () => {
    const tool = createBashTool(root, { timeoutMs: 300 });

    const result = await tool.execute("call-1", { command: "sleep 30" });

    const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    expect(text).toContain("timed out");
    expect(result.details.ok).toBe(true);
    if (!result.details.ok) return;
    expect(result.details.timedOut).toBe(true);
  });

  it("returns a blocked command as a result value, not an exception", async () => {
    const tool = createBashTool(root);

    const result = await tool.execute("call-1", { command: "rm -rf /" });

    const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    expect(text).toContain("blocked by mori bash guard");
    expect(result.details.ok).toBe(false);
  });
});

describe("beforeToolCall wiring in the agent loop", () => {
  /**
   * Drives a real `Agent` through one blocked tool call.
   *
   * The tool is a stub that records invocation and never spawns anything — the point
   * is to prove the hook stops execution and that the refusal reaches the transcript
   * as a tool result, without ever putting a destructive command near a shell.
   */
  it("delivers a block to the model as an error tool result instead of throwing", async () => {
    const { Agent } = await import("@earendil-works/pi-agent-core");
    const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");

    let executed = 0;
    const stubParameters = Type.Object({ command: Type.String() });
    const stubBash: AgentTool<typeof stubParameters> = {
      name: BASH_TOOL_NAME,
      label: "Bash",
      description: "stub",
      parameters: stubParameters,
      execute: async () => {
        executed += 1;
        return { content: [{ type: "text", text: "ran" }], details: undefined };
      },
    };

    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    let turn = 0;
    const agent = new Agent({
      initialState: {
        systemPrompt: "test",
        model: { id: "test-model", api: "anthropic-messages", provider: "anthropic" } as any,
        tools: [stubBash],
      },
      streamFn: (model) => {
        const stream = createAssistantMessageEventStream();
        const base: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage,
          stopReason: "stop",
          timestamp: 0,
        };

        stream.push({ type: "start", partial: base });

        if (turn++ === 0) {
          const toolCall = {
            type: "toolCall" as const,
            id: "call-1",
            name: BASH_TOOL_NAME,
            arguments: { command: "rm -rf /" },
          };
          const final: AssistantMessage = { ...base, content: [toolCall], stopReason: "toolUse" };
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: final });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: final });
          stream.push({ type: "done", reason: "toolUse", message: final });
        } else {
          const final: AssistantMessage = { ...base, content: [{ type: "text", text: "ok" }] };
          stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: final });
          stream.push({ type: "done", reason: "stop", message: final });
        }

        return stream;
      },
      beforeToolCall: createBashBeforeToolCall(),
    });

    await agent.prompt("delete everything");

    const toolResult = agent.state.messages.find((message) => message.role === "toolResult");
    expect(toolResult).toBeDefined();
    expect(toolResult?.role === "toolResult" && toolResult.isError).toBe(true);
    const text = (toolResult?.role === "toolResult" ? toolResult.content : [])
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    expect(text).toContain("blocked by mori bash guard");
    expect(text).toContain("rm-root");
    expect(executed).toBe(0);
  });
});

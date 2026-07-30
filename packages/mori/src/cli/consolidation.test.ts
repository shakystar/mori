import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ConsolidatorLlm } from "@mori/kernel";
import { describe, expect, it } from "vitest";
import type { MoriKernel } from "../agent/index.js";
import { consolidateExplicit, consolidateOnSessionEnd } from "./consolidation.js";

function stubLlm(): ConsolidatorLlm {
  return { complete: async () => "[]" };
}

/** A `MoriKernel` whose `consolidate` is a spy calling `onConsolidate` instead of doing anything real. */
function spyKernel(onConsolidate: (llm: ConsolidatorLlm) => Promise<void>): MoriKernel {
  return {
    transformContext: async (messages: AgentMessage[]) => messages,
    observe: () => {},
    drain: async () => {},
    consolidate: onConsolidate,
  };
}

describe("consolidateOnSessionEnd", () => {
  it("calls kernel.consolidate exactly once when an llm is configured", async () => {
    const calls: ConsolidatorLlm[] = [];
    const kernel = spyKernel(async (llm) => {
      calls.push(llm);
    });
    const llm = stubLlm();

    await consolidateOnSessionEnd(kernel, llm, () => {
      throw new Error("onError must not fire on success");
    });

    expect(calls).toEqual([llm]);
  });

  it("skips silently when no llm is configured", async () => {
    const kernel = spyKernel(async () => {
      throw new Error("kernel.consolidate must not be called");
    });
    const errors: string[] = [];

    await consolidateOnSessionEnd(kernel, undefined, (message) => errors.push(message));

    expect(errors).toEqual([]);
  });

  it("swallows a throwing consolidate() and reports it through onError instead", async () => {
    const kernel = spyKernel(async () => {
      throw new Error("boom");
    });
    const errors: string[] = [];

    await expect(
      consolidateOnSessionEnd(kernel, stubLlm(), (message) => errors.push(message)),
    ).resolves.toBeUndefined();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("boom");
    // A message, not a stack trace — the exit code (index.ts/runtime.ts) must stay 0.
    expect(errors[0]).not.toMatch(/at .+\(.+:\d+:\d+\)/);
  });
});

describe("consolidateExplicit", () => {
  it("reports skipped when no llm is configured, without touching the kernel", async () => {
    const kernel = spyKernel(async () => {
      throw new Error("kernel.consolidate must not be called");
    });

    const outcome = await consolidateExplicit(kernel, undefined);

    expect(outcome).toEqual({ kind: "skipped" });
  });

  it("reports ok after a successful consolidate()", async () => {
    const kernel = spyKernel(async () => {});

    const outcome = await consolidateExplicit(kernel, stubLlm());

    expect(outcome).toEqual({ kind: "ok" });
  });

  it("reports failed with the error, rather than throwing", async () => {
    const kernel = spyKernel(async () => {
      throw new Error("boom");
    });

    const outcome = await consolidateExplicit(kernel, stubLlm());

    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.error).toBeInstanceOf(Error);
  });
});

describe("overlapping triggers (#107)", () => {
  it("serializes an explicit call and a session-end call on the same kernel — never concurrently", async () => {
    const events: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;

    const kernel = spyKernel(async () => {
      const mine = ++calls;
      events.push(`start-${mine}`);
      if (mine === 1) await firstGate;
      events.push(`end-${mine}`);
    });
    const llm = stubLlm();

    // Neither call is awaited yet — this is the "explicit invocation in flight when the
    // session ends" scenario from the issue, expressed without a real REPL/CLI in the loop.
    const explicit = consolidateExplicit(kernel, llm);
    const sessionEnd = consolidateOnSessionEnd(kernel, llm, () => {});

    // Flush pending microtasks (not just one) without relying on a specific number of
    // `.then` hops inside the guard — a macrotask boundary is a hard flush of all of them.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The second call must not have started while the first is still pending.
    expect(events).toEqual(["start-1"]);

    releaseFirst();
    await Promise.all([explicit, sessionEnd]);

    expect(events).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });
});

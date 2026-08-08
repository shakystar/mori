import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ConsolidateCallOptions, ConsolidatorLlm } from "@mori/kernel";
import { describe, expect, it } from "vitest";
import type { MoriKernel } from "../agent/index.js";
import {
  consolidateAfterCompact,
  consolidateExplicit,
  consolidateOnSessionEnd,
} from "./consolidation.js";

function stubLlm(): ConsolidatorLlm {
  return { complete: async () => "[]" };
}

/** A `MoriKernel` whose `consolidate` is a spy calling `onConsolidate` instead of doing anything real. */
function spyKernel(
  onConsolidate: (llm: ConsolidatorLlm, opts?: ConsolidateCallOptions) => Promise<void>,
): MoriKernel {
  return {
    transformContext: async (messages: AgentMessage[]) => messages,
    observe: () => {},
    drain: async () => {},
    resetConversation: () => {},
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

  it("passes boundary: session-end on every call (#141)", async () => {
    const opts: (ConsolidateCallOptions | undefined)[] = [];
    const kernel = spyKernel(async (_llm, o) => {
      opts.push(o);
    });

    await consolidateOnSessionEnd(kernel, stubLlm(), () => {
      throw new Error("onError must not fire on success");
    });

    expect(opts).toEqual([{ boundary: "session-end" }]);
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

  it("passes boundary: manual and the given signal to kernel.consolidate (#141)", async () => {
    const opts: (ConsolidateCallOptions | undefined)[] = [];
    const kernel = spyKernel(async (_llm, o) => {
      opts.push(o);
    });
    const controller = new AbortController();

    await consolidateExplicit(kernel, stubLlm(), controller.signal);

    expect(opts).toEqual([{ boundary: "manual", signal: controller.signal }]);
  });

  it("reports cancelled, not failed, when kernel.consolidate rejects with an AbortError AND this call's signal aborted (#141, #167)", async () => {
    const kernel = spyKernel(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    const controller = new AbortController();
    controller.abort();

    const outcome = await consolidateExplicit(kernel, stubLlm(), controller.signal);

    expect(outcome).toEqual({ kind: "cancelled" });
  });

  it("reports failed, not cancelled, for an AbortError when this call's own signal never aborted (#167)", async () => {
    // #167: once the kernel forwards `signal` into the extraction request, a provider's OWN
    // transport-level abort (timeout, connection reset) can reject with the same `AbortError`
    // name without the user ever cancelling anything. Matching on the name alone would hide
    // that as a clean cancellation instead of a real failure.
    const kernel = spyKernel(async () => {
      const error = new Error("upstream connection reset");
      error.name = "AbortError";
      throw error;
    });

    const outcome = await consolidateExplicit(kernel, stubLlm(), new AbortController().signal);

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

  it("serializes a post-compact call behind a session-end call on the same kernel (#409)", async () => {
    // The overlap #409 makes ordinary: the post-compact boundary fires off nothing but
    // context size at the end of a turn, so it can land while another boundary is still
    // inside its extraction call. `consolidate-service`'s watermark does not cover this —
    // both would read the same window and both append. Only the per-kernel chain does.
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

    const sessionEnd = consolidateOnSessionEnd(kernel, llm, () => {});
    const postCompact = consolidateAfterCompact(kernel, llm);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual(["start-1"]);

    releaseFirst();
    await Promise.all([sessionEnd, postCompact]);

    expect(events).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  it("labels the post-compact boundary and skips silently without an llm (#409)", async () => {
    const opts: (ConsolidateCallOptions | undefined)[] = [];
    const kernel = spyKernel(async (_llm, o) => {
      opts.push(o);
    });

    await consolidateAfterCompact(kernel, stubLlm());
    await consolidateAfterCompact(kernel, undefined);

    expect(opts).toEqual([{ boundary: "post-compact" }]);
  });
});

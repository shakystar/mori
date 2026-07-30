import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createObservation,
  createProject,
  type ObservationSignal,
} from "../../src/domain/entities.js";
import type {
  ConsolidatorLlm,
  ConversationSlice,
  ConversationSource,
  Embedder,
} from "../../src/index.js";
import {
  ExtractionParseError,
  chunkConversation,
  consolidate,
  getConsolidateWatermark,
  parseExtractedMemories,
  readLastConsolidateAttempt,
  setConsolidateWatermark,
  type Consolidator,
} from "../../src/services/consolidate-service.js";
import { listOpenConflicts, listValidMemories } from "../../src/services/projection-store.js";
import { listSegments } from "../../src/services/segment-store.js";
import { closeAll } from "../../src/storage/db.js";
import { appendEvent, readEvents } from "../../src/storage/event-store.js";

let sandbox: string;
let projectId: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mori-consolidate-"));
  process.env.MEMORIZE_ROOT = sandbox;

  const project = createProject({ title: "consolidate", rootPath: join(sandbox, "p") });
  projectId = project.id;
  await appendEvent({
    type: "project.created",
    projectId,
    scopeType: "project",
    scopeId: projectId,
    actor: "test",
    payload: project,
  });
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  delete process.env.MEMORIZE_RAW_SEGMENTS;
  await rm(sandbox, { recursive: true, force: true });
});

async function seedObservation(
  summary: string,
  signal: ObservationSignal = "decision-keyword",
): Promise<string> {
  const observation = createObservation({ projectId, signal, summary, toolName: "Bash" });
  await appendEvent({
    type: "observation.captured",
    projectId,
    scopeType: "session",
    scopeId: projectId,
    actor: "test",
    payload: observation,
  });
  return observation.id;
}

/** A `ConsolidatorLlm` that replays canned replies and records every prompt. */
function fakeLlm(replies: string[]): ConsolidatorLlm & { prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  return {
    prompts,
    async complete(prompt: string): Promise<string> {
      prompts.push(prompt);
      return replies[Math.min(i++, replies.length - 1)] ?? "[]";
    },
  };
}

/** A `ConversationSource` that replays canned slices and records requested offsets. */
function fakeConversation(
  slices: Array<ConversationSlice | undefined>,
  id = "conv-1",
): ConversationSource & { offsets: number[] } {
  const offsets: number[] = [];
  let i = 0;
  return {
    id,
    offsets,
    async read(offset: number): Promise<ConversationSlice | undefined> {
      offsets.push(offset);
      return slices[i++];
    },
  };
}

describe("parseExtractedMemories", () => {
  it("parses a well-formed array and clamps salience", () => {
    const items = parseExtractedMemories(
      'noise before [{"kind":"decision","text":" use sqlite ","salience":99}] noise after',
    );
    expect(items).toEqual([{ kind: "decision", text: "use sqlite", salience: 10 }]);
  });

  it("drops entries with an unknown kind, blank text, or a non-object shape", () => {
    const items = parseExtractedMemories(
      JSON.stringify([
        { kind: "wat", text: "x", salience: 5 },
        { kind: "decision", text: "   ", salience: 5 },
        "a string",
        ["an array"],
        null,
        { kind: "progress", text: "kept", salience: 5 },
      ]),
    );
    expect(items).toEqual([{ kind: "progress", text: "kept", salience: 5 }]);
  });

  it("caps the item count at the boundary noise guard unless raised", () => {
    const many = JSON.stringify(
      Array.from({ length: 30 }, (_, i) => ({ kind: "progress", text: `m${i}`, salience: 5 })),
    );
    expect(parseExtractedMemories(many)).toHaveLength(12);
    expect(parseExtractedMemories(many, { maxItems: 25 })).toHaveLength(25);
  });

  it("sanitizes #57 evidence fields instead of failing the entry", () => {
    const [item] = parseExtractedMemories(
      JSON.stringify([
        {
          kind: "decision",
          text: "keep",
          salience: 5,
          obsoleteWhen: "   ",
          kindMisfitReason: "no flag, so dropped",
          supersedesNote: "  replaced the old plan  ",
          tags: ["  Alpha ", "alpha", 7, "", "b", "c", "d", "e", "f"],
        },
      ]),
    );
    expect(item).toEqual({
      kind: "decision",
      text: "keep",
      salience: 5,
      supersedesNote: "replaced the old plan",
      tags: ["alpha", "b", "c", "d", "e"],
    });
  });

  it("throws ExtractionParseError when the reply holds no parseable array", () => {
    expect(() => parseExtractedMemories("I could not comply.")).toThrow(ExtractionParseError);
    expect(() => parseExtractedMemories("[not json]")).toThrow(ExtractionParseError);
    expect(() => parseExtractedMemories('{"kind":"decision"}')).toThrow(ExtractionParseError);
  });
});

describe("chunkConversation", () => {
  it("packs whole turns up to the budget and never splits a turn", () => {
    const long = "x".repeat(40);
    expect(chunkConversation(`a\n\nb\n\n${long}\n\nc`, 10)).toEqual(["a\n\nb", long, "c"]);
  });

  it("returns [] for blank input", () => {
    expect(chunkConversation("   \n\n  ")).toEqual([]);
  });
});

describe("consolidate — extractor selection", () => {
  it("uses the injected ConsolidatorLlm and reports backend 'llm'", async () => {
    await seedObservation("decided to use sqlite");
    const llm = fakeLlm(['[{"kind":"decision","text":"use sqlite","salience":8}]']);

    const result = await consolidate({ projectId, actor: "test", llm });

    expect(result).toMatchObject({
      extractor: "llm",
      backend: "llm",
      consolidated: 1,
      outcome: "ok",
    });
    expect(llm.prompts).toHaveLength(1);
    expect(llm.prompts[0]).toContain("decided to use sqlite");
    expect(listValidMemories(projectId).map((r) => r.memory.text)).toEqual(["use sqlite"]);
  });

  it("falls back to the rule-based extractor when no LLM is injected", async () => {
    await seedObservation("decided to drop the cache");
    await seedObservation("Write: src/a.ts", "write-tool");

    const result = await consolidate({ projectId, actor: "test" });

    expect(result).toMatchObject({ extractor: "rule-based", backend: "rule-based", outcome: "ok" });
    const texts = listValidMemories(projectId).map((r) => r.memory.text);
    expect(texts).toContain("decided to drop the cache");
    expect(texts.some((t) => t.startsWith("Edited 1 file(s)"))).toBe(true);
  });

  it("prefers an explicitly injected consolidator over the LLM", async () => {
    await seedObservation("anything");
    const consolidator: Consolidator = {
      async extract() {
        return [{ kind: "progress", text: "from the override", salience: 5 }];
      },
    };

    const result = await consolidate({
      projectId,
      actor: "test",
      llm: fakeLlm(["[]"]),
      consolidator,
    });

    expect(result).toMatchObject({ extractor: "custom", backend: "custom" });
    expect(listValidMemories(projectId).map((r) => r.memory.text)).toEqual(["from the override"]);
  });
});

describe("consolidate — watermark", () => {
  it("advances past the processed window so the next boundary is a no-op", async () => {
    await seedObservation("first");
    const first = await consolidate({ projectId, actor: "test" });
    expect(first.observationsProcessed).toBe(1);
    expect(getConsolidateWatermark(projectId)).toBeDefined();

    const second = await consolidate({ projectId, actor: "test" });
    expect(second).toMatchObject({ observationsProcessed: 0, consolidated: 0, outcome: "noop" });
  });

  it("leaves the watermark behind when extraction fails, so the window retries", async () => {
    await seedObservation("decided something");
    const failing: Consolidator = {
      async extract() {
        throw new Error("boom");
      },
    };

    await expect(consolidate({ projectId, actor: "test", consolidator: failing })).rejects.toThrow(
      "boom",
    );
    expect(getConsolidateWatermark(projectId)).toBeUndefined();

    const retry = await consolidate({ projectId, actor: "test" });
    expect(retry.observationsProcessed).toBe(1);
  });

  it("advances past a fully-consumed window even when nothing new is extracted", async () => {
    await seedObservation("first");
    await consolidate({ projectId, actor: "test" });
    const watermark = getConsolidateWatermark(projectId);

    // Watermark loss (a wiped meta table) must not re-consolidate history: the
    // observation is already recorded as a memory's source.
    setConsolidateWatermark(projectId, "evt_nonexistent");
    const result = await consolidate({ projectId, actor: "test" });

    expect(result).toMatchObject({ observationsProcessed: 0, outcome: "noop" });
    expect(getConsolidateWatermark(projectId)).toBe(watermark);
    expect(listValidMemories(projectId)).toHaveLength(1);
  });
});

describe("consolidate — supersede hints", () => {
  it("supersedes only ids that are currently valid", async () => {
    await seedObservation("first decision");
    await consolidate({
      projectId,
      actor: "test",
      consolidator: {
        async extract() {
          return [{ kind: "decision", text: "old truth", salience: 7 }];
        },
      },
    });
    const oldId = listValidMemories(projectId)[0]!.memory.id;

    await seedObservation("second decision");
    const result = await consolidate({
      projectId,
      actor: "test",
      consolidator: {
        async extract() {
          return [
            {
              kind: "decision",
              text: "new truth",
              salience: 7,
              supersedesMemoryId: oldId,
              supersedeReason: "reversed",
            },
            {
              kind: "decision",
              text: "hallucinated supersede",
              salience: 7,
              supersedesMemoryId: "mem_does_not_exist",
            },
          ];
        },
      },
    });

    expect(result).toMatchObject({ consolidated: 2, superseded: 1 });
    expect(
      listValidMemories(projectId)
        .map((r) => r.memory.text)
        .sort(),
    ).toEqual(["hallucinated supersede", "new truth"]);
    const superseded = (await readEvents(projectId)).filter((e) => e.type === "memory.superseded");
    expect(superseded).toHaveLength(1);
    expect(superseded[0]!.payload).toMatchObject({ supersedes: oldId, reason: "reversed" });
  });
});

describe("consolidate — conversation seam", () => {
  it("feeds the slice to the extractor, writes segments, and advances the offset", async () => {
    const conversation = fakeConversation([
      { text: "USER: why sqlite?\n\nAGENT: because it is embedded", newOffset: 512 },
      { text: "USER: and later?\n\nAGENT: still sqlite", newOffset: 900 },
    ]);
    const consolidator: Consolidator = {
      async extract(input) {
        return input.transcriptTail
          ? [{ kind: "rationale", text: input.transcriptTail.slice(0, 20), salience: 5 }]
          : [];
      },
    };

    const first = await consolidate({ projectId, actor: "test", conversation, consolidator });
    expect(conversation.offsets).toEqual([0]);
    expect(first.segmentsWritten).toBe(1);
    expect(listSegments(projectId).map((s) => s.source)).toEqual(["conv-1"]);

    await consolidate({ projectId, actor: "test", conversation, consolidator });
    // Second boundary resumes from the offset the first one reported.
    expect(conversation.offsets).toEqual([0, 512]);
    expect(listSegments(projectId)).toHaveLength(2);
  });

  it("consolidates a conversation-only boundary that captured zero observations", async () => {
    const conversation = fakeConversation([{ text: "USER: remember the plan", newOffset: 10 }]);

    const result = await consolidate({
      projectId,
      actor: "test",
      conversation,
      consolidator: {
        async extract() {
          return [{ kind: "progress", text: "the plan", salience: 5 }];
        },
      },
    });

    // No observations were processed, but the conversation slice was — #103
    // widened the outcome to cover that, so this boundary is 'ok', and the
    // last-attempt telemetry (#51) records the memory it produced.
    expect(result).toMatchObject({ observationsProcessed: 0, consolidated: 1, outcome: "ok" });
    expect(listValidMemories(projectId)).toHaveLength(1);
    expect(listSegments(projectId)).toHaveLength(1);
    expect(readLastConsolidateAttempt(projectId)).toMatchObject({ outcome: "ok", consolidated: 1 });
  });

  it("is an observation-only boundary when the source yields nothing", async () => {
    await seedObservation("decided x");
    const conversation = fakeConversation([undefined]);

    const result = await consolidate({ projectId, actor: "test", conversation });

    expect(result.segmentsWritten).toBe(0);
    expect(listSegments(projectId)).toHaveLength(0);
    expect(result.observationsProcessed).toBe(1);
  });

  it("skips the raw-detail buffer when MEMORIZE_RAW_SEGMENTS=0", async () => {
    process.env.MEMORIZE_RAW_SEGMENTS = "0";
    const conversation = fakeConversation([{ text: "USER: hello", newOffset: 4 }]);

    const result = await consolidate({
      projectId,
      actor: "test",
      conversation,
      consolidator: {
        async extract() {
          return [{ kind: "progress", text: "hello", salience: 5 }];
        },
      },
    });

    expect(result.segmentsWritten).toBe(0);
    expect(listSegments(projectId)).toHaveLength(0);
  });
});

describe("consolidate — semantic wiring", () => {
  it("embeds the new memories and resolves a semantic contradiction", async () => {
    const vectors: Record<string, number[]> = {
      "ship on friday": [1, 0, 0],
      "do not ship on friday": [0.99, 0.01, 0],
    };
    const embedder: Embedder = {
      model: "fake-embed-v1",
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map((t) => vectors[t] ?? [0, 0, 1]);
      },
    };
    const llm: ConsolidatorLlm = {
      async complete(prompt: string): Promise<string> {
        // The judge prompt is the only one asking for a contradicts verdict.
        return prompt.includes("GENUINELY CONTRADICT")
          ? '{"contradicts":true,"reason":"opposite release calls"}'
          : "[]";
      },
    };

    await seedObservation("release call");
    await consolidate({
      projectId,
      actor: "test",
      llm,
      embedder,
      consolidator: {
        async extract() {
          return [
            { kind: "decision", text: "ship on friday", salience: 8 },
            { kind: "decision", text: "do not ship on friday", salience: 8 },
          ];
        },
      },
    });

    // One of the two decisions lost and was superseded, and a conflict was raised.
    expect(listValidMemories(projectId)).toHaveLength(1);
    expect(listOpenConflicts(projectId)).toHaveLength(1);
  });

  it("runs clean with neither embedder nor LLM injected", async () => {
    await seedObservation("decided to keep it simple");
    const result = await consolidate({ projectId, actor: "test" });
    expect(result.consolidated).toBeGreaterThan(0);
    expect(listOpenConflicts(projectId)).toHaveLength(0);
  });
});


// #113 ① — the rule-based fallback must never promote a write-tool
// observation's raw content into a searchable memory. `evaluateCapture`'s own
// type is an unenforced plain string, so this simulates a caller that hands
// it file content anyway (the #109/PR #127 path contract lives at the harness
// wiring layer, not here) and asserts the leak is structurally impossible.
describe("consolidate — rule-based fallback never echoes write-tool content (#113)", () => {
  it("never puts a write-tool observation's summary/filePath value into memory text", async () => {
    const secret = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const observation = createObservation({
      projectId,
      signal: "write-tool",
      toolName: "Write",
      summary: `Write: ${secret}`,
      filePath: secret,
    });
    await appendEvent({
      type: "observation.captured",
      projectId,
      scopeType: "session",
      scopeId: projectId,
      actor: "test",
      payload: observation,
    });

    const result = await consolidate({ projectId, actor: "test" });

    expect(result).toMatchObject({ extractor: "rule-based", outcome: "ok" });
    const texts = listValidMemories(projectId).map((r) => r.memory.text);
    expect(texts.some((t) => t.startsWith("Edited 1 file(s)"))).toBe(true);
    for (const text of texts) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain("AWS_SECRET_ACCESS_KEY");
    }
  });

  it("dedups the edit count by the structured filePath without ever emitting a path", async () => {
    const pathA = "/repo/src/a.ts";
    const pathB = "/repo/src/b.ts";
    for (const filePath of [pathA, pathA, pathB]) {
      const observation = createObservation({
        projectId,
        signal: "write-tool",
        toolName: "Edit",
        summary: `Edit: ${filePath}`,
        filePath,
      });
      await appendEvent({
        type: "observation.captured",
        projectId,
        scopeType: "session",
        scopeId: projectId,
        actor: "test",
        payload: observation,
      });
    }

    await consolidate({ projectId, actor: "test" });

    const texts = listValidMemories(projectId).map((r) => r.memory.text);
    expect(texts).toContain("Edited 2 file(s)");
    expect(texts.some((t) => t.includes(pathA) || t.includes(pathB))).toBe(false);
  });
});

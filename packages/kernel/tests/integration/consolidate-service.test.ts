import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION } from "../../src/domain/common.js";
import {
  createConsolidatedMemory,
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
  EXPECTED_MAX_OUTPUT_CHARS,
  EXTRACTION_SYSTEM_PROMPT,
  ExtractionParseError,
  MAX_EXTRACTION_INPUT_CHARS,
  MAX_MEMORIES_PER_BOUNDARY,
  PER_ITEM_MAX_CHARS,
  RESERVED_OUTPUT_TOKENS,
  boundExtractionInput,
  buildExtractionUserContent,
  chunkConversation,
  consolidate,
  estimateTokens,
  extractionCharBudget,
  getConsolidateWatermark,
  getConsolidationStatus,
  parseExtractedMemories,
  readLastConsolidateAttempt,
  reservedOutputTokensFor,
  resumePointsOf,
  setConsolidateWatermark,
  shouldTriggerThresholdConsolidate,
  type Consolidator,
} from "../../src/services/consolidate-service.js";
import {
  listOpenConflicts,
  listValidMemories,
  rebuildProjectProjection,
} from "../../src/services/projection-store.js";
import { insertSegments, listSegments } from "../../src/services/segment-store.js";
import { closeAll, getDb } from "../../src/storage/db.js";
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

/** A `observation.captured` carried in by a workspace union sibling (#113
 *  item②) — same db, foreign lane, via the same `sourceProjectId` provenance
 *  override `projection-lane.test.ts` uses for tasks/memories. */
async function seedForeignObservation(
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
    sourceProjectId: "proj_lane_foreign_sibling",
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

/** {@link fakeLlm} plus a declared `contextWindowTokens` (#143 item②). */
function fakeLlmWithContext(
  contextWindowTokens: number,
  replies: string[],
): ConsolidatorLlm & { prompts: string[] } {
  return { ...fakeLlm(replies), contextWindowTokens };
}

/**
 * A `ConversationSource` that replays canned slices and records requested
 * offsets. The canned slices carry `resumePoints: []` — the all-or-nothing
 * contract (#144), which is what the hold behaviour below is a property of.
 * For a source that CAN resume mid-slice, see `fakeStreamConversation`.
 */
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

/**
 * A `ConversationSource` over one fixed conversation whose offset IS a char
 * index into it — the shape a real harness has (mori's conversation is
 * `agent.state.messages`, an in-process append-only list), and the shape that
 * can name resume points: every turn boundary inside the returned slice.
 *
 * Unlike `fakeConversation` this is not a canned script — it answers whatever
 * offset it is handed, so a test can drive boundaries until the cursor reaches
 * the end and see whether it ever gets there (#144).
 */
function fakeStreamConversation(
  full: string,
  id = "conv-stream",
): ConversationSource & { offsets: number[] } {
  const offsets: number[] = [];
  return {
    id,
    offsets,
    async read(offset: number): Promise<ConversationSlice | undefined> {
      offsets.push(offset);
      if (offset >= full.length) return undefined;
      const text = full.slice(offset);
      // Turn boundaries ("\n\n") inside the slice, as prefix lengths. The
      // offset of a prefix is just where it ends in the whole conversation,
      // which is exactly the value `read` would need to resume there.
      const resumePoints: Array<{ chars: number; offset: number }> = [];
      for (let i = text.indexOf("\n\n"); i !== -1; i = text.indexOf("\n\n", i + 1)) {
        const chars = i + 2;
        if (chars < text.length) resumePoints.push({ chars, offset: offset + chars });
      }
      return { text, newOffset: full.length, resumePoints };
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

  // #213 (PR #197 Codex P1, relayed): item COUNT alone doesn't bound output
  // size — a single schema-valid, item-count-compliant item can still blow
  // the per-item output budget on `text` length. Truncated (policy i), not
  // dropped, and reported via `onTruncate` instead of silently.
  it("truncates (not drops) an item whose rendered size exceeds PER_ITEM_MAX_CHARS, even though item count is within the boundary cap", () => {
    const longText = "x".repeat(PER_ITEM_MAX_CHARS + 100);
    let truncatedCount = 0;
    const items = parseExtractedMemories(
      JSON.stringify([{ kind: "decision", text: longText, salience: 5 }]),
      {
        onTruncate: () => {
          truncatedCount += 1;
        },
      },
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.text.length).toBeLessThan(longText.length);
    expect(JSON.stringify(items[0]).length).toBeLessThanOrEqual(PER_ITEM_MAX_CHARS);
    expect(truncatedCount).toBe(1);
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

describe("EXTRACTION_SYSTEM_PROMPT — count cap stated at generation time (#169)", () => {
  it("states MAX_MEMORIES_PER_BOUNDARY, not a hardcoded number", () => {
    const occurrences =
      EXTRACTION_SYSTEM_PROMPT.split(String(MAX_MEMORIES_PER_BOUNDARY)).length - 1;
    // The prompt must actually reference the cap (not just happen to avoid
    // the number some other way) — bumping MAX_MEMORIES_PER_BOUNDARY changes
    // this rendered prompt, which is the point: the two can never drift apart.
    expect(occurrences).toBeGreaterThan(0);
  });
});

// #213 (PR #197 Codex P1, relayed): the count cap alone doesn't bound output
// SIZE — the prompt must also state a per-item character cap and a
// whole-reply character cap, both interpolated from the same derived
// constants `parseExtractedMemories` enforces post-hoc, so the instruction
// and the enforcement can never drift apart (same convention as
// MAX_MEMORIES_PER_BOUNDARY above).
describe("EXTRACTION_SYSTEM_PROMPT — output size cap stated at generation time (#213)", () => {
  it("states PER_ITEM_MAX_CHARS and EXPECTED_MAX_OUTPUT_CHARS, not hardcoded numbers", () => {
    const perItemOccurrences =
      EXTRACTION_SYSTEM_PROMPT.split(String(PER_ITEM_MAX_CHARS)).length - 1;
    const totalOccurrences =
      EXTRACTION_SYSTEM_PROMPT.split(String(EXPECTED_MAX_OUTPUT_CHARS)).length - 1;
    // Bumping either constant changes this rendered prompt — the numbers can
    // never silently fall out of step with what the parser actually enforces.
    expect(perItemOccurrences).toBeGreaterThan(0);
    expect(totalOccurrences).toBeGreaterThan(0);
  });
});

// #213: pins the arithmetic invariant PER_ITEM_MAX_CHARS relies on — an
// honest reply that fills every one of MAX_MEMORIES_PER_BOUNDARY slots up to
// the stated per-item cap must not, by construction, exceed the whole-reply
// cap the kernel actually reserved output tokens for.
describe("PER_ITEM_MAX_CHARS — derived per-item budget never overruns the whole-reply budget (#213)", () => {
  it("MAX_MEMORIES_PER_BOUNDARY * PER_ITEM_MAX_CHARS stays within EXPECTED_MAX_OUTPUT_CHARS", () => {
    expect(MAX_MEMORIES_PER_BOUNDARY * PER_ITEM_MAX_CHARS).toBeLessThanOrEqual(
      EXPECTED_MAX_OUTPUT_CHARS,
    );
    // The sum of the items is not the reply: `[`, `]` and the commas between
    // items are chars the model has to emit too. Asserted on a REAL rendered
    // array so the derivation has to account for them rather than land the
    // arithmetic just inside the budget and the actual reply just outside it.
    const fullReply = JSON.stringify(
      Array.from({ length: MAX_MEMORIES_PER_BOUNDARY }, () => "x".repeat(PER_ITEM_MAX_CHARS - 2)),
    );
    expect(fullReply.length).toBeLessThanOrEqual(EXPECTED_MAX_OUTPUT_CHARS);
  });
});

// PR #197 review (#169): the provider-side generation cap and the prompt's
// own item/size allowance had drifted apart — RESERVED_OUTPUT_TOKENS (1,300)
// was far smaller than what a full MAX_MEMORIES_PER_BOUNDARY-item CJK-heavy
// reply is allowed to render to, so an otherwise valid reply could still hit
// `stopReason: "length"`. This pins the invariant the fix relies on: the cap
// must be AT LEAST the token estimate for the worst-case output size, using
// this file's own conversion (`estimateTokens`) — not a hand-picked number
// that can silently fall out of step with it again.
describe("RESERVED_OUTPUT_TOKENS — generation cap stays consistent with the allowed output size (#169)", () => {
  it("is at least estimateTokens(EXPECTED_MAX_OUTPUT_CHARS)", () => {
    expect(RESERVED_OUTPUT_TOKENS).toBeGreaterThanOrEqual(
      estimateTokens(EXPECTED_MAX_OUTPUT_CHARS),
    );
  });
});

// Owner decision 2026-08-03 (PR #197 review, #169 x #174 interaction): raising
// RESERVED_OUTPUT_TOKENS from 1,300 to 7,500 (above) reintroduced #174's
// regression on the OUTPUT axis — on a 4k-8k declared window, the unclamped
// reservation alone could exceed the window, flooring extractionCharBudget's
// input side to 0 again. `reservedOutputTokensFor` arbitrates: it clamps the
// reservation to half of what's left after the (fixed) system prompt, so
// input and output both get a share instead of one starving the other.
describe("reservedOutputTokensFor — output reservation stays within the declared window (#169 x #174)", () => {
  it("falls back to the unclamped RESERVED_OUTPUT_TOKENS when no context window is declared", () => {
    expect(reservedOutputTokensFor(undefined)).toBe(RESERVED_OUTPUT_TOKENS);
  });

  it("matches the unclamped RESERVED_OUTPUT_TOKENS for a wide declared context window (no behavior change)", () => {
    expect(reservedOutputTokensFor(128_000)).toBe(RESERVED_OUTPUT_TOKENS);
  });

  it("clamps below RESERVED_OUTPUT_TOKENS for a narrow declared context window, leaving room for input", () => {
    const reserved = reservedOutputTokensFor(4_000);
    expect(reserved).toBeLessThan(RESERVED_OUTPUT_TOKENS);
    expect(reserved).toBeGreaterThan(0);
    expect(reserved).toBeLessThan(4_000);
  });

  it("never exceeds the declared context window itself, however narrow", () => {
    expect(reservedOutputTokensFor(500)).toBeLessThanOrEqual(500);
    expect(reservedOutputTokensFor(0)).toBe(0);
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
    // No structured `filePath` on this observation, so the fallback reports the
    // count it can stand behind — edits, not files.
    expect(texts.some((t) => t.startsWith("Made 1 file edit(s)"))).toBe(true);
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
      {
        text: "USER: why sqlite?\n\nAGENT: because it is embedded",
        newOffset: 512,
        resumePoints: [],
      },
      { text: "USER: and later?\n\nAGENT: still sqlite", newOffset: 900, resumePoints: [] },
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
    const conversation = fakeConversation([
      { text: "USER: remember the plan", newOffset: 10, resumePoints: [] },
    ]);

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
    const conversation = fakeConversation([
      { text: "USER: hello", newOffset: 4, resumePoints: [] },
    ]);

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
// This is the regression check for "category 2" of the storage-boundary
// forbidden list — docs/storage-boundary-secrets.md (#188 C).
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

// #113 ② — readEventsSince has no lane concept, so a synced sibling's
// observation.captured events (same db, foreign `source_project_id`) must be
// filtered out before they reach the extractor or the backlog count, the same
// way listRecentObservations already scopes to self by default.
describe("consolidate — excludes foreign-lane observations (#113)", () => {
  it("does not fold a foreign-lane observation into a consolidated memory", async () => {
    await seedObservation("decided to keep this self decision");
    await seedForeignObservation("decided to leak this foreign decision");

    const result = await consolidate({ projectId, actor: "test" });

    expect(result.observationsProcessed).toBe(1);
    const texts = listValidMemories(projectId).map((r) => r.memory.text);
    expect(texts).toContain("decided to keep this self decision");
    expect(texts).not.toContain("decided to leak this foreign decision");
  });

  it("excludes foreign-lane observations from the pendingObservations attempt telemetry", async () => {
    await seedObservation("self decision");
    await seedForeignObservation("foreign decision one");
    await seedForeignObservation("foreign mutation two", "mutating-bash");

    await consolidate({ projectId, actor: "test" });

    expect(readLastConsolidateAttempt(projectId)).toMatchObject({ pendingObservations: 1 });
  });

  it("excludes foreign-lane observations from the threshold backlog that fires a boundary", async () => {
    await seedObservation("self decision");
    for (let i = 0; i < 25; i++) {
      await seedForeignObservation(`foreign decision ${i}`);
    }

    // The backlog a boundary would actually distill is 1, not 26 — otherwise a
    // foreign-only backlog crosses the local threshold and fires a boundary
    // that immediately finds nothing of its own to do.
    expect(getConsolidationStatus(projectId).pendingObservations).toBe(1);
    expect(shouldTriggerThresholdConsolidate(projectId)).toBe(false);
  });

  it("still advances past a foreign-only window instead of rescanning it forever", async () => {
    await seedForeignObservation("foreign only, no self observations");

    const result = await consolidate({ projectId, actor: "test" });

    expect(result).toMatchObject({ observationsProcessed: 0, outcome: "noop" });
    expect(getConsolidateWatermark(projectId)).toBeDefined();

    const second = await consolidate({ projectId, actor: "test" });
    expect(second).toMatchObject({ observationsProcessed: 0, outcome: "noop" });
  });
});

/**
 * Inserts a raw `events` row bypassing `appendEvent` — needed to construct a
 * row `appendEvent` itself can never produce: a NULL `source_project_id`
 * (every normal append defaults it to the writer's own project id) whose
 * `project_id` column differs from the local store's identity, i.e. a
 * pre-Phase-0 legacy row a workspace union carried in under its ORIGINAL
 * writer's id. Same technique `observation-lane-backfill.test.ts` uses
 * against a hand-built old-schema db; here the current (already-migrated)
 * `events` table has the same columns, so it writes straight into it.
 */
function insertRawEvent(params: {
  id: string;
  type: string;
  eventProjectId: string;
  sourceProjectId: string | null;
  createdAt: string;
  payload: unknown;
}): void {
  getDb(projectId)
    .prepare(
      `INSERT INTO events
         (id, schema_version, created_at, updated_at, type,
          project_id, scope_type, scope_id, actor, writer, source_project_id, payload)
       VALUES (?, ?, ?, ?, ?, ?, 'project', ?, 'test', 'test', ?, ?)`,
    )
    .run(
      params.id,
      CURRENT_SCHEMA_VERSION,
      params.createdAt,
      params.createdAt,
      params.type,
      params.eventProjectId,
      params.eventProjectId,
      params.sourceProjectId,
      JSON.stringify(params.payload),
    );
}

// #143 item① — `getConsolidationStatus` used to materialize every pending
// event row into JS just to run `laneOf` over it; a workspace union's foreign
// backlog never crosses the local threshold (so it never advances the
// watermark) and only grows, so every status call re-read all of it. These
// pin the SQL-aggregate replacement (`laneWhereSql`) to the exact same
// classification `laneOf` makes.
describe("getConsolidationStatus — aggregate SQL backlog count (#143)", () => {
  it("counts only self-lane observations for both count and oldest, ignoring a larger foreign backlog", async () => {
    for (let i = 0; i < 5; i++) {
      await seedForeignObservation(`foreign ${i}`);
    }
    const firstSelfId = await seedObservation("self oldest");
    await seedObservation("self middle");
    await seedObservation("self newest");

    const status = getConsolidationStatus(projectId);
    expect(status.pendingObservations).toBe(3);

    const events = await readEvents(projectId);
    const firstSelfEvent = events.find(
      (e) => e.type === "observation.captured" && (e.payload as { id: string }).id === firstSelfId,
    );
    expect(status.oldestPendingAt).toBe(firstSelfEvent!.createdAt);
  });

  it("behaves as before for a non-union (single-genesis) store", async () => {
    await seedObservation("solo self decision one");
    await seedObservation("solo self decision two");

    const status = getConsolidationStatus(projectId);
    expect(status.pendingObservations).toBe(2);
    expect(status.oldestPendingAt).toBeDefined();
  });

  it("classifies a legacy NULL-provenance row by isUnion + the event's own project_id, matching laneOf", async () => {
    const FOREIGN = "proj_legacy_foreign_member";
    // A second genesis in the SAME db makes `isUnionLog(projectId)` true —
    // the same trigger both `run()`'s lane filter and this status query key
    // off, so a single-genesis store never hits this branch of `laneOf`.
    insertRawEvent({
      id: "evt_foreign_genesis",
      type: "project.created",
      eventProjectId: FOREIGN,
      sourceProjectId: FOREIGN,
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        id: FOREIGN,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        title: "foreign member",
        summary: "foreign",
        goals: [],
        status: "active",
        rootPath: "/tmp/foreign",
        activeWorkstreamIds: [],
        activeTaskIds: [],
        acceptedDecisionIds: [],
        ruleIds: [],
      },
    });

    // Legacy row that is genuinely THIS store's own history: no source column
    // at all (pre-Phase-0), but its own project_id already names this store.
    insertRawEvent({
      id: "evt_legacy_self_obs",
      type: "observation.captured",
      eventProjectId: projectId,
      sourceProjectId: null,
      createdAt: "2026-01-02T00:00:00.000Z",
      payload: {
        id: "obs_legacy_self",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        projectId,
        sessionId: "s1",
        signal: "decision-keyword",
        summary: "legacy self observation",
      },
    });

    // Legacy row that rode in under a foreign member's OWN project_id — the
    // exact shape `laneOf`'s doc calls out ("a foreign member's legacy block
    // rides in under ITS projectId"). Older than the self row above, so a
    // naive MIN(created_at) with no lane filter would wrongly report it.
    insertRawEvent({
      id: "evt_legacy_foreign_obs",
      type: "observation.captured",
      eventProjectId: FOREIGN,
      sourceProjectId: null,
      createdAt: "2026-01-01T12:00:00.000Z",
      payload: {
        id: "obs_legacy_foreign",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt: "2026-01-01T12:00:00.000Z",
        updatedAt: "2026-01-01T12:00:00.000Z",
        projectId: FOREIGN,
        sessionId: "s1",
        signal: "decision-keyword",
        summary: "legacy foreign observation",
      },
    });

    const status = getConsolidationStatus(projectId);
    expect(status.pendingObservations).toBe(1);
    expect(status.oldestPendingAt).toBe("2026-01-02T00:00:00.000Z");
  });
});

// #113 ③ — the extraction prompt has no cap on observations / existing
// memories / conversation tail, and a context-limit rejection is treated as
// an ordinary (non-advancing) extractor failure, so an oversized window would
// retry forever, only ever growing. boundExtractionInput fixes the size; the
// watermark logic in consolidate() uses its result so the excess is retried
// (never lost) by later boundaries instead.
describe("boundExtractionInput / buildExtractionUserContent — input budget (#113)", () => {
  it("keeps the rendered prompt within MAX_EXTRACTION_INPUT_CHARS for an oversized window", () => {
    const observations = Array.from({ length: 500 }, (_, i) =>
      createObservation({
        projectId,
        signal: "decision-keyword",
        summary: `decision number ${i} `.repeat(20),
        toolName: "Bash",
      }),
    );
    const existingMemories = Array.from({ length: 500 }, (_, i) =>
      createConsolidatedMemory({
        projectId,
        kind: "progress",
        text: `memory ${i} `.repeat(20),
        salience: 5,
      }),
    );

    const bounded = boundExtractionInput({
      observations,
      existingMemories,
      transcriptTail: "x".repeat(50_000),
    });

    expect(buildExtractionUserContent(bounded).length).toBeLessThanOrEqual(
      MAX_EXTRACTION_INPUT_CHARS,
    );
    expect(bounded.observations.length).toBeGreaterThan(0);
  });

  it("always keeps at least one observation even when it alone exceeds the budget", () => {
    const bounded = boundExtractionInput({
      observations: [
        createObservation({
          projectId,
          signal: "decision-keyword",
          summary: "z".repeat(MAX_EXTRACTION_INPUT_CHARS * 2),
          toolName: "Bash",
        }),
      ],
      existingMemories: [],
    });

    expect(bounded.observations).toHaveLength(1);
  });

  it("marks observationsTruncated and keeps a PREFIX (oldest-first) when trimming", () => {
    const observations = Array.from({ length: 500 }, (_, i) =>
      createObservation({
        projectId,
        signal: "decision-keyword",
        summary: `obs ${i} `.repeat(30),
        toolName: "Bash",
      }),
    );

    const bounded = boundExtractionInput({ observations, existingMemories: [] });

    expect(bounded.observationsTruncated).toBe(true);
    expect(bounded.observations.length).toBeLessThan(observations.length);
    expect(bounded.observations[0]).toBe(observations[0]);
    expect(bounded.observations.at(-1)).toBe(observations[bounded.observations.length - 1]);
  });

  it("sacrifices the transcript tail before observations or existing memories", () => {
    const bounded = boundExtractionInput({
      observations: [
        createObservation({
          projectId,
          signal: "decision-keyword",
          summary: "one decision",
          toolName: "Bash",
        }),
      ],
      existingMemories: [],
      transcriptTail: "y".repeat(MAX_EXTRACTION_INPUT_CHARS * 2),
    });

    // The observation is kept whole; the tail takes the cut.
    expect(bounded.observations).toHaveLength(1);
    expect(bounded.observationsTruncated).toBe(false);
    expect(bounded.transcriptTail!.length).toBeLessThan(MAX_EXTRACTION_INPUT_CHARS * 2);
    expect(buildExtractionUserContent(bounded).length).toBeLessThanOrEqual(
      MAX_EXTRACTION_INPUT_CHARS,
    );
  });

  // Codex P1 on PR #136: stopping the observation trim at one item without
  // also shortening THAT item left the returned input over the advertised
  // bound, so a provider could still reject the prompt — and since #43 holds
  // the watermark on a failed extraction, that one observation would be
  // retried forever.
  it("clips the last surviving observation's summary so the bound holds even for it alone", () => {
    const observation = createObservation({
      projectId,
      signal: "decision-keyword",
      summary: "z".repeat(MAX_EXTRACTION_INPUT_CHARS * 2),
      toolName: "Bash",
    });

    const bounded = boundExtractionInput({ observations: [observation], existingMemories: [] });

    expect(bounded.observations).toHaveLength(1);
    expect(buildExtractionUserContent(bounded).length).toBeLessThanOrEqual(
      MAX_EXTRACTION_INPUT_CHARS,
    );
    // Clipped, not dropped — and still the SAME observation, so the watermark
    // may legitimately advance past it.
    expect(bounded.observations[0]!.id).toBe(observation.id);
    expect(bounded.observations[0]!.summary!.length).toBeLessThan(observation.summary!.length);
  });

  it("gives the tail the leftover budget instead of dropping it whole", () => {
    const tail = Array.from({ length: 4000 }, (_, i) => `USER: line ${i}`).join("\n\n");

    const bounded = boundExtractionInput({
      observations: [
        createObservation({
          projectId,
          signal: "decision-keyword",
          summary: "one decision",
          toolName: "Bash",
        }),
      ],
      existingMemories: [],
      transcriptTail: tail,
    });

    expect(bounded.transcriptTailCoverage).toBe("clipped");
    expect(bounded.transcriptTail).toBeDefined();
    // Keeps the turns NEAREST the boundary.
    expect(bounded.transcriptTail!.endsWith(tail.slice(-200))).toBe(true);
    expect(buildExtractionUserContent(bounded).length).toBeLessThanOrEqual(
      MAX_EXTRACTION_INPUT_CHARS,
    );
  });

  it("flags a tail dropped outright when the observations left no room for it", () => {
    const bounded = boundExtractionInput({
      observations: [
        createObservation({
          projectId,
          signal: "decision-keyword",
          summary: "z".repeat(MAX_EXTRACTION_INPUT_CHARS * 2),
          toolName: "Bash",
        }),
      ],
      existingMemories: [],
      transcriptTail: "conversation that will not fit",
    });

    expect(bounded.transcriptTail).toBeUndefined();
    expect(bounded.transcriptTailCoverage).toBe("dropped");
  });

  // Owner adjudication on PR #136 (Codex P2 `:377`): the postcondition is
  // "the returned input ALWAYS renders within maxChars", with no exception —
  // and clipping only `summary` left one: the renderer puts `toolName` on the
  // same line as a separate field, and nothing upstream clips it.
  it("clips a toolName that overruns the budget on its own", () => {
    const observation = createObservation({
      projectId,
      signal: "decision-keyword",
      summary: "short",
      toolName: "T".repeat(MAX_EXTRACTION_INPUT_CHARS * 2),
    });

    const bounded = boundExtractionInput({ observations: [observation], existingMemories: [] });

    expect(bounded.observations).toHaveLength(1);
    expect(buildExtractionUserContent(bounded).length).toBeLessThanOrEqual(
      MAX_EXTRACTION_INPUT_CHARS,
    );
    // Clipped, not dropped: id/provenance survive, so the watermark may still
    // advance past an observation the extractor genuinely saw.
    expect(bounded.observations[0]!.id).toBe(observation.id);
    expect(bounded.observations[0]!.toolName!.length).toBeLessThan(observation.toolName!.length);
  });

  // Owner adjudication on PR #136 (Codex P1 `:393`): with the raw buffer off
  // the tail is the conversation's only copy, so it must be RESERVED ahead of
  // the (recoverable) existing-memory section rather than fed the leftovers.
  it("reserves the whole tail ahead of existing memories when the raw buffer is off", () => {
    const existingMemories = Array.from({ length: 500 }, (_, i) =>
      createConsolidatedMemory({
        projectId,
        kind: "progress",
        text: `memory ${i} `.repeat(20),
        salience: 5,
      }),
    );
    const tail = Array.from({ length: 300 }, (_, i) => `USER: turn ${i}`).join("\n\n");

    const reserved = boundExtractionInput(
      {
        observations: [
          createObservation({
            projectId,
            signal: "decision-keyword",
            summary: "one decision",
            toolName: "Bash",
          }),
        ],
        existingMemories,
        transcriptTail: tail,
      },
      { tailPersistedElsewhere: false },
    );

    expect(reserved.transcriptTailCoverage).toBe("whole");
    expect(reserved.transcriptTail).toBe(tail);
    expect(buildExtractionUserContent(reserved).length).toBeLessThanOrEqual(
      MAX_EXTRACTION_INPUT_CHARS,
    );

    // With the raw buffer ON the same slice is stored as segments either way,
    // so shortening it is the cheap sacrifice again and memories fill first.
    const leftover = boundExtractionInput(
      {
        observations: [
          createObservation({
            projectId,
            signal: "decision-keyword",
            summary: "one decision",
            toolName: "Bash",
          }),
        ],
        existingMemories,
        transcriptTail: tail,
      },
      { tailPersistedElsewhere: true },
    );

    expect(leftover.existingMemories.length).toBeGreaterThan(reserved.existingMemories.length);
    expect(leftover.transcriptTailCoverage).not.toBe("whole");
  });

  it("stays fast on a large valid-memory history (binary search, not drop-one-at-a-time)", () => {
    const existingMemories = Array.from({ length: 20_000 }, (_, i) =>
      createConsolidatedMemory({
        projectId,
        kind: "progress",
        text: `memory ${i} `.repeat(20),
        salience: 5,
      }),
    );

    const startedAt = Date.now();
    const bounded = boundExtractionInput({
      observations: [
        createObservation({
          projectId,
          signal: "decision-keyword",
          summary: "one decision",
          toolName: "Bash",
        }),
      ],
      existingMemories,
    });

    // The quadratic version rendered all 20k memories once per dropped memory.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(buildExtractionUserContent(bounded).length).toBeLessThanOrEqual(
      MAX_EXTRACTION_INPUT_CHARS,
    );
    // Keeps the NEWEST memories.
    expect(bounded.existingMemories.at(-1)).toBe(existingMemories.at(-1));
  });
});

describe("consolidate — bounded input keeps the watermark self-healing (#113)", () => {
  it("advances on an oversized backlog and drains it over successive boundaries instead of retrying forever", async () => {
    const bigSummary = "y".repeat(2000);
    const total = 30;
    for (let i = 0; i < total; i++) {
      await seedObservation(`${bigSummary} #${i}`, "decision-keyword");
    }

    const noopConsolidator: Consolidator = {
      async extract() {
        return [];
      },
    };

    const first = await consolidate({ projectId, actor: "test", consolidator: noopConsolidator });
    // The window was too big to show in full — only a bounded PREFIX was
    // processed, proving a single call can no longer fail purely from size.
    expect(first.observationsProcessed).toBeGreaterThan(0);
    expect(first.observationsProcessed).toBeLessThan(total);
    expect(getConsolidateWatermark(projectId)).toBeDefined();

    // The untouched remainder is retried — not lost — by later boundaries,
    // draining to zero rather than looping on the same ever-growing window.
    let remaining = total - first.observationsProcessed;
    let guard = 0;
    while (remaining > 0 && guard < total) {
      const next = await consolidate({ projectId, actor: "test", consolidator: noopConsolidator });
      expect(next.observationsProcessed).toBeGreaterThan(0);
      remaining -= next.observationsProcessed;
      guard += 1;
    }
    expect(remaining).toBe(0);

    const drained = await consolidate({ projectId, actor: "test", consolidator: noopConsolidator });
    expect(drained).toMatchObject({ observationsProcessed: 0, outcome: "noop" });
  });
});

// #143 item② — MAX_EXTRACTION_INPUT_CHARS is a fixed char count, so it makes
// no promise about TOKENS: a CJK-heavy prompt (this project's own
// observations/conversation are substantially Korean) runs far more tokens
// per char than the English text the constant was sized against, and a
// small local model's real context can be smaller than the constant assumes
// either way. `extractionCharBudget` derives the char budget from the
// injected LLM's declared `contextWindowTokens` instead, when it has one.
// #174 (was #143 item②, PR #168 review round 3): CONSERVATIVE_CHARS_PER_TOKEN
// is 1/3, and `estimateTokens` used to apply it to the system prompt too — a
// ~2.1KB system prompt inflated to ~6,400 "tokens", already exceeding a
// 4,000-token window before any budget was left for user content. Fixed by
// #174 with a system-prompt-specific ratio (see `SYSTEM_PROMPT_CHARS_PER_TOKEN`
// in consolidate-service.ts); 16,000 leaves plenty of headroom (~4,600 derived
// chars) to still exercise clipping/narrow-window/drain behavior below, which
// is the point of these tests — a window so narrow the budget floors to 0
// would test nothing. Kept at 16,000 rather than narrowed further: it's
// already comfortably above the #174 regression floor and still small enough
// to force clipping in "still guarantees at least one observation...".
const NARROW_CONTEXT_WINDOW_TOKENS = 16_000;

describe("extractionCharBudget — model-aware extraction budget (#143)", () => {
  it("falls back to MAX_EXTRACTION_INPUT_CHARS when the LLM declares no context window", () => {
    expect(extractionCharBudget(undefined)).toBe(MAX_EXTRACTION_INPUT_CHARS);
    expect(extractionCharBudget({ complete: async () => "[]" })).toBe(MAX_EXTRACTION_INPUT_CHARS);
  });

  it("derives a strictly smaller budget from a small declared context window", () => {
    const budget = extractionCharBudget({
      complete: async () => "[]",
      contextWindowTokens: NARROW_CONTEXT_WINDOW_TOKENS,
    });
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThan(MAX_EXTRACTION_INPUT_CHARS);
  });

  // #174 — before that fix, `estimateTokens` applied the CJK-worst-case
  // `CONSERVATIVE_CHARS_PER_TOKEN` to the (English, fixed) system prompt too,
  // inflating it to ~6,400 "tokens" and leaving an 8,192-token window only
  // 267 derived chars — not enough for a single observation to survive
  // `boundExtractionInput`'s minimum. Guards the regression directly.
  //
  // Threshold recalibrated 1_000 -> 900 by #212: that issue corrected
  // `SYSTEM_PROMPT_CHARS_PER_TOKEN` from `3` (an English-BPE rule of thumb,
  // which undercounted the fixed prompt for a byte-level tokenizer) to `1`
  // (that tokenizer's exact ASCII worst case), which counts a few hundred
  // more system-prompt tokens and so legitimately lowers the derived budget
  // at every window (1,236 -> 978 at 8,192). 900 keeps the assertion
  // meaningful — it still fails hard against the #174 regression's ~267 (or
  // a floor of 0), it just isn't tuned to a stale pre-#212 number that
  // assumed an undercounted system prompt.
  it("leaves a usable budget for an 8,192-token declared context window", () => {
    const budget = extractionCharBudget({
      complete: async () => "[]",
      contextWindowTokens: 8_192,
    });
    expect(budget).toBeGreaterThanOrEqual(900);
  });

  // #174 — same regression, at the floor: before the fix this window's
  // derived budget was 0 (`Math.max(0, …)` clamped it), so extraction ran
  // with an empty input budget on every boundary.
  it("does not floor the derived budget to 0 for a 4,000-token declared context window", () => {
    const budget = extractionCharBudget({
      complete: async () => "[]",
      contextWindowTokens: 4_000,
    });
    expect(budget).not.toBe(0);
  });

  it("keeps the estimated prompt tokens (system + rendered user content) within a small declared context window, for a dense CJK backlog", async () => {
    // CJK observation content: no spaces, so this stresses the same axis the
    // issue calls out — many tokens per character relative to English.
    const cjk = "가".repeat(6_000);
    await seedObservation(cjk, "decision-keyword");

    const llm = fakeLlmWithContext(NARROW_CONTEXT_WINDOW_TOKENS, ["[]"]);
    await consolidate({ projectId, actor: "test", llm });

    expect(llm.prompts.length).toBe(1);
    // Deliberately NOT `promptLength / CONSERVATIVE_CHARS_PER_TOKEN` (PR #168
    // review, Codex + owner): that reuses the exact approximation
    // `extractionCharBudget` used to derive the budget in the first place, so
    // the assertion moves in lockstep with that constant and stays green even
    // if it regresses back to an unsafe value. Instead, estimate worst-case
    // tokens per script independently: Hangul syllables at 3 tokens/char (the
    // worst case `CONSERVATIVE_CHARS_PER_TOKEN`'s doc argues from, round 3 of
    // this review) and everything else (the English system prompt,
    // punctuation) at a generous 4 chars/token — unrelated to the production
    // constant, so this only passes if the render is ACTUALLY within budget,
    // not merely consistent with itself.
    const prompt = llm.prompts[0]!;
    const hangulChars = prompt.match(/[가-힣]/g)?.length ?? 0;
    const otherChars = prompt.length - hangulChars;
    const independentEstimatedTokens = hangulChars * 3 + otherChars / 4;
    expect(independentEstimatedTokens).toBeLessThanOrEqual(
      NARROW_CONTEXT_WINDOW_TOKENS - RESERVED_OUTPUT_TOKENS,
    );
  });

  it("still guarantees at least one observation per boundary and drains the backlog under a narrow declared window", async () => {
    const bigSummary = "y".repeat(2000);
    const total = 8;
    for (let i = 0; i < total; i++) {
      await seedObservation(`${bigSummary} #${i}`, "decision-keyword");
    }

    const llm = fakeLlmWithContext(NARROW_CONTEXT_WINDOW_TOKENS, Array(total).fill("[]"));

    const first = await consolidate({ projectId, actor: "test", llm });
    expect(first.observationsProcessed).toBeGreaterThan(0);
    expect(first.observationsProcessed).toBeLessThan(total);

    let remaining = total - first.observationsProcessed;
    let guard = 0;
    while (remaining > 0 && guard < total) {
      const next = await consolidate({ projectId, actor: "test", llm });
      expect(next.observationsProcessed).toBeGreaterThan(0);
      remaining -= next.observationsProcessed;
      guard += 1;
    }
    expect(remaining).toBe(0);

    const drained = await consolidate({ projectId, actor: "test", llm });
    expect(drained).toMatchObject({ observationsProcessed: 0, outcome: "noop" });
  });
});

// #212 (PR #196 Codex P1) — SYSTEM_PROMPT_CHARS_PER_TOKEN is an English-BPE
// approximation (~4 chars/token, with margin). A byte-level tokenizer's worst
// case for the fixed ASCII EXTRACTION_SYSTEM_PROMPT is 1 BYTE = 1 TOKEN
// (EXTRACTION_SYSTEM_PROMPT.length, exactly), not the ~4x-fewer count the
// English approximation assumes. Reproduces the issue's own table
// independently of SYSTEM_PROMPT_CHARS_PER_TOKEN (a hardcoded byte-level
// count, not `EXTRACTION_SYSTEM_PROMPT.length / SYSTEM_PROMPT_CHARS_PER_TOKEN`
// — same reasoning as the CJK backlog test above, so this only passes if the
// render is ACTUALLY within budget under that tokenizer, not merely
// self-consistent with the constant under test): worst-case total tokens a
// byte-level-tokenizer provider would see — the fixed system prompt at 1
// char/token, the derived user budget at its own declared CJK worst case (1
// char <= 3 tokens), and the output reservation actually requested — must
// never exceed the declared context window. Before this issue's fix this
// failed on every narrow window (e.g. a 4,000-token window overshoots to
// ~5,546 actual tokens before a single user character is sent) — see PR body
// for the failing run.
describe("extractionCharBudget — system prompt accounting under a byte-level tokenizer (#212)", () => {
  const byteLevelSystemPromptTokens = EXTRACTION_SYSTEM_PROMPT.length;

  it.each([2_400, 3_000, 4_000, 8_192, 16_000, 128_000])(
    "stays within a %i-token declared context window for a CJK-heavy worst case",
    (contextWindowTokens) => {
      const llm = { complete: async () => "[]", contextWindowTokens };
      const budgetChars = extractionCharBudget(llm);
      const reservedOutput = reservedOutputTokensFor(contextWindowTokens);
      const worstCaseUserTokens = budgetChars * 3; // CJK: 1 char <= 3 tokens
      const worstCaseTotal = byteLevelSystemPromptTokens + worstCaseUserTokens + reservedOutput;
      expect(worstCaseTotal).toBeLessThanOrEqual(contextWindowTokens);
    },
  );
});

// Codex P1 on PR #136: the tail was dropped on the argument that the raw
// slice is durably stored as segments anyway — but those writes are gated on
// MEMORIZE_RAW_SEGMENTS, so with the buffer off a dropped slice was neither
// extracted nor stored while its cursor advanced regardless.
describe("consolidate — never consumes a conversation slice it neither showed nor stored (#113)", () => {
  /** An observation whose summary alone eats the whole extraction budget. */
  async function seedBudgetFillingObservation(): Promise<void> {
    await seedObservation("q".repeat(MAX_EXTRACTION_INPUT_CHARS * 2), "decision-keyword");
  }

  it("holds the conversation cursor when the tail was dropped and the raw buffer is off", async () => {
    process.env.MEMORIZE_RAW_SEGMENTS = "0";
    await seedBudgetFillingObservation();
    const conversation = fakeConversation([
      { text: "USER: this must not vanish", newOffset: 512, resumePoints: [] },
      { text: "USER: this must not vanish\n\nUSER: more", newOffset: 900, resumePoints: [] },
    ]);
    const seen: Array<string | undefined> = [];
    const consolidator: Consolidator = {
      async extract(input) {
        seen.push(input.transcriptTail);
        return [];
      },
    };

    await consolidate({ projectId, actor: "test", conversation, consolidator });
    expect(seen[0]).toBeUndefined();
    expect(listSegments(projectId)).toHaveLength(0);

    await consolidate({ projectId, actor: "test", conversation, consolidator });
    // Re-read from 0: the slice was never shown, never stored, so it was not
    // consumed either.
    expect(conversation.offsets).toEqual([0, 0]);
  });

  it("advances the cursor for a dropped tail when the raw buffer captured it", async () => {
    await seedBudgetFillingObservation();
    const conversation = fakeConversation([
      { text: "USER: stored verbatim instead", newOffset: 512, resumePoints: [] },
      { text: "USER: next", newOffset: 900, resumePoints: [] },
    ]);
    const consolidator: Consolidator = {
      async extract() {
        return [];
      },
    };

    const first = await consolidate({ projectId, actor: "test", conversation, consolidator });
    expect(first.segmentsWritten).toBeGreaterThan(0);

    await consolidate({ projectId, actor: "test", conversation, consolidator });
    expect(conversation.offsets).toEqual([0, 512]);
  });

  /** A valid-memory history that alone overruns the extraction budget — the
   *  premise of item ③ (`listValidMemories` is unbounded). Projections are
   *  rebuilt at the end: `appendEvent` only writes the log, and `consolidate`
   *  reads the memory section through `listValidMemories`, so without this the
   *  history would be invisible and the budget pressure fictional. */
  async function seedOversizedMemoryHistory(): Promise<void> {
    for (let i = 0; i < 300; i++) {
      await appendEvent({
        type: "memory.consolidated",
        projectId,
        scopeType: "session",
        scopeId: projectId,
        actor: "test",
        payload: createConsolidatedMemory({
          projectId,
          kind: "progress",
          text: `filler memory ${i} `.repeat(20),
          salience: 5,
        }),
      });
    }
    await rebuildProjectProjection(projectId, { reindexSearch: false });
  }

  // Owner adjudication on PR #136 (Codex P1 `:393`): letting existing memories
  // take the budget greedily and the tail have the leftovers starved the tail
  // FOREVER once the memory history outgrew the budget — the leftover is by
  // construction under one memory line, the next boundary allocates the same
  // way, and memory history never shrinks. Two consecutive boundaries are the
  // minimum that can catch it: a single-boundary test sees a held cursor and
  // cannot tell "held once" from "held for good".
  it("advances the conversation cursor over successive boundaries when the memory history alone exceeds the budget", async () => {
    process.env.MEMORIZE_RAW_SEGMENTS = "0";
    await seedOversizedMemoryHistory();
    // Slices comfortably inside the budget on their own, but larger than the
    // crumb a greedy memory fill leaves behind (under one memory line) — which
    // is exactly the size a leftover-allocated tail can never grow past.
    const sliceText = (label: string): string =>
      Array.from({ length: 40 }, (_, i) => `USER: ${label} turn ${i} `.repeat(2)).join("\n\n");
    const conversation = fakeConversation([
      { text: sliceText("first"), newOffset: 512, resumePoints: [] },
      { text: sliceText("second"), newOffset: 900, resumePoints: [] },
    ]);
    const seen: Array<string | undefined> = [];
    const consolidator: Consolidator = {
      async extract(input) {
        seen.push(input.transcriptTail);
        return [];
      },
    };

    const first = await consolidate({ projectId, actor: "test", conversation, consolidator });
    expect(seen[0]).toBe(sliceText("first"));
    expect(first.conversationSliceHeld).toBe(false);
    expect(listSegments(projectId)).toHaveLength(0);

    const second = await consolidate({ projectId, actor: "test", conversation, consolidator });
    expect(seen[1]).toBe(sliceText("second"));
    expect(second.conversationSliceHeld).toBe(false);
    // Second read starts where the first slice ended: the cursor moved, and
    // kept moving, instead of pinning the conversation axis.
    expect(conversation.offsets).toEqual([0, 512]);
  });

  // Owner adjudication on PR #136 (Codex P1 `:1350`): a CLIPPED tail was
  // treated as "shown", so the cursor advanced over a prefix the extractor
  // never saw — the same loss as dropping it, moved to a different branch.
  it("holds the cursor for a merely CLIPPED tail, and says so on the result and the attempt", async () => {
    process.env.MEMORIZE_RAW_SEGMENTS = "0";
    // One slice larger than the whole budget: not even zero memories make room
    // for it, so no allocation policy can show it whole.
    const huge = Array.from({ length: 4000 }, (_, i) => `USER: line ${i}`).join("\n\n");
    const conversation = fakeConversation([
      { text: huge, newOffset: 512, resumePoints: [] },
      { text: `${huge}\n\nUSER: later`, newOffset: 900, resumePoints: [] },
    ]);
    const seen: Array<string | undefined> = [];
    const consolidator: Consolidator = {
      async extract(input) {
        seen.push(input.transcriptTail);
        return [];
      },
    };

    const first = await consolidate({ projectId, actor: "test", conversation, consolidator });
    // Partly shown — and therefore NOT consumed.
    expect(seen[0]!.length).toBeLessThan(huge.length);
    expect(first.conversationSliceHeld).toBe(true);
    expect(readLastConsolidateAttempt(projectId)?.conversationSliceHeld).toBe(true);

    await consolidate({ projectId, actor: "test", conversation, consolidator });
    expect(conversation.offsets).toEqual([0, 0]);
  });

  it("advances the cursor for an empty slice, which has nothing to lose", async () => {
    process.env.MEMORIZE_RAW_SEGMENTS = "0";
    await seedObservation("decided x");
    const conversation = fakeConversation([
      { text: "", newOffset: 77, resumePoints: [] },
      { text: "", newOffset: 88, resumePoints: [] },
    ]);

    await consolidate({ projectId, actor: "test", conversation });
    await consolidate({ projectId, actor: "test", conversation });

    expect(conversation.offsets).toEqual([0, 77]);
  });
});

// #144: holding the cursor (above) is right but it is not a RECOVERY. A slice
// that cannot fit the extraction budget was re-read, unchanged and only ever
// larger, at every later boundary — the conversation axis stopped for good.
// `ConversationSlice.resumePoints` makes partial consumption expressible, so
// the kernel can commit the offset of the prefix it actually showed.
describe("consolidate — drains a slice larger than the extraction budget (#144)", () => {
  /** A conversation several times `MAX_EXTRACTION_INPUT_CHARS`, in turns no
   *  single one of which is oversized — so the ONLY thing that can make it
   *  consumable is cutting it at a resume point. */
  function oversizedConversation(): string {
    const turns = Array.from({ length: 400 }, (_, i) => `USER: turn ${i} ${"detail ".repeat(20)}`);
    const full = turns.join("\n\n");
    expect(full.length).toBeGreaterThan(MAX_EXTRACTION_INPUT_CHARS * 3);
    return full;
  }

  it("drains it across boundaries, consuming exactly what each boundary was shown", async () => {
    process.env.MEMORIZE_RAW_SEGMENTS = "0";
    const full = oversizedConversation();
    const conversation = fakeStreamConversation(full);
    const shown: string[] = [];
    const consolidator: Consolidator = {
      async extract(input) {
        shown.push(input.transcriptTail ?? "");
        return [];
      },
    };

    // Drive boundaries until the source has been read past the end. The guard
    // is what makes this a stall test: before #144 the cursor never moved, so
    // the loop would exhaust it with the first offset still at 0.
    let guard = 0;
    while ((conversation.offsets.at(-1) ?? 0) < full.length && guard < 20) {
      const result = await consolidate({ projectId, actor: "test", conversation, consolidator });
      expect(result.conversationSliceHeld).toBe(false);
      guard += 1;
    }

    // ① The offset is strictly monotone and reaches the end of the slice.
    expect(conversation.offsets.at(-1)).toBe(full.length);
    expect(conversation.offsets.length).toBeGreaterThan(2);
    for (let i = 1; i < conversation.offsets.length; i++) {
      expect(conversation.offsets[i]!).toBeGreaterThan(conversation.offsets[i - 1]!);
    }

    // ② Each boundary consumed only what it was SHOWN: the region the cursor
    //    moved over is a substring of that boundary's extraction input, so the
    //    cursor can never have run past the extractor.
    const consumed = conversation.offsets
      .slice(1)
      .map((offset, i) => full.slice(conversation.offsets[i]!, offset));
    expect(shown).toHaveLength(consumed.length);
    consumed.forEach((region, i) => {
      expect(region.length).toBeGreaterThan(0);
      expect(shown[i]!).toContain(region);
    });

    // ③ Zero regions lost: the consumed regions tile the conversation exactly
    //    — no gap (a skipped stretch) and no overlap (a re-consumed one). The
    //    unshown remainder of each boundary is precisely the next one's input.
    expect(consumed.join("")).toBe(full);

    // ④ The hold this issue was opened about no longer fires, on the result or
    //    on the attempt telemetry.
    expect(readLastConsolidateAttempt(projectId)?.conversationSliceHeld).toBeUndefined();
  });

  it("ignores resume points that would move the cursor over unshown content", async () => {
    process.env.MEMORIZE_RAW_SEGMENTS = "0";
    const huge = Array.from({ length: 4000 }, (_, i) => `USER: line ${i}`).join("\n\n");
    // Every point is invalid in a different way: past the slice's own end,
    // backwards from the current cursor, and outside the text. A source that
    // hands these over must not be able to consume anything.
    const bogus = [
      { chars: 100, offset: 999_999 },
      { chars: 200, offset: 0 },
      { chars: huge.length + 10, offset: 5 },
    ];
    const conversation = fakeConversation([
      { text: huge, newOffset: 512, resumePoints: bogus },
      { text: `${huge}\n\nUSER: later`, newOffset: 900, resumePoints: bogus },
    ]);
    const consolidator: Consolidator = {
      async extract() {
        return [];
      },
    };

    const first = await consolidate({ projectId, actor: "test", conversation, consolidator });
    expect(first.conversationSliceHeld).toBe(true);

    await consolidate({ projectId, actor: "test", conversation, consolidator });
    expect(conversation.offsets).toEqual([0, 0]);
  });

  // A source that hands over `[null, …]` is not hypothetical: `resumePoints`
  // crosses the harness boundary, so it may arrive from JSON or untyped JS.
  // Reading `.chars` off such an element would throw INSIDE the boundary, and
  // `read` is contractually allowed to be unhelpful but never to fail — so one
  // bad element must cost only itself, not the slice's ability to drain.
  it("drains past malformed resume-point entries instead of failing the boundary", async () => {
    process.env.MEMORIZE_RAW_SEGMENTS = "0";
    const full = oversizedConversation();
    const base = fakeStreamConversation(full);
    const conversation: ConversationSource & { offsets: number[] } = {
      id: base.id,
      offsets: base.offsets,
      async read(offset: number): Promise<ConversationSlice | undefined> {
        const slice = await base.read(offset);
        if (!slice) return slice;
        // Poison the array around the real points, so a validator that trips
        // on the first bad element loses the good ones behind it too.
        return {
          ...slice,
          resumePoints: [
            null,
            undefined,
            42,
            "nope",
            ...slice.resumePoints,
            null,
          ] as unknown as ConversationSlice["resumePoints"],
        };
      },
    };
    const consolidator: Consolidator = {
      async extract() {
        return [];
      },
    };

    let guard = 0;
    while ((conversation.offsets.at(-1) ?? 0) < full.length && guard < 20) {
      const result = await consolidate({ projectId, actor: "test", conversation, consolidator });
      expect(result.conversationSliceHeld).toBe(false);
      guard += 1;
    }

    // The surviving points still drain the slice to the end, monotonically —
    // i.e. the malformed entries were dropped individually, not fatally.
    expect(conversation.offsets.at(-1)).toBe(full.length);
    expect(conversation.offsets.length).toBeGreaterThan(2);
    for (let i = 1; i < conversation.offsets.length; i++) {
      expect(conversation.offsets[i]!).toBeGreaterThan(conversation.offsets[i - 1]!);
    }
  });

  // The `offset === newOffset` hole: an INTERNAL point (`chars < text.length`)
  // that declares the whole slice's cursor. It fits any budget, so it would be
  // picked for an oversized tail, and committing it drops `text.slice(chars)`
  // unshown and unstored. The bound has to be strict for internal points.
  it("holds rather than consuming an internal resume point that carries the terminal offset", async () => {
    process.env.MEMORIZE_RAW_SEGMENTS = "0";
    const huge = Array.from({ length: 4000 }, (_, i) => `USER: line ${i}`).join("\n\n");
    // `chars: 100` is a tiny prefix that trivially fits the budget, while the
    // slice as a whole does not — the exact case the point would be chosen for.
    const terminal = [{ chars: 100, offset: 512 }];
    const conversation = fakeConversation([
      { text: huge, newOffset: 512, resumePoints: terminal },
      { text: huge, newOffset: 512, resumePoints: terminal },
    ]);
    const shown: string[] = [];
    const consolidator: Consolidator = {
      async extract(input) {
        shown.push(input.transcriptTail ?? "");
        return [];
      },
    };

    const first = await consolidate({ projectId, actor: "test", conversation, consolidator });
    expect(first.conversationSliceHeld).toBe(true);
    // Nothing was consumed on the strength of that point: had it been kept,
    // the boundary would have shown the 100-char prefix and committed 512.
    expect(shown[0]).not.toBe(huge.slice(0, 100));

    await consolidate({ projectId, actor: "test", conversation, consolidator });
    // The cursor never moved, so the unshown suffix is back in the next
    // boundary's input in full — held, not lost.
    expect(conversation.offsets).toEqual([0, 0]);
  });

  // The deliberate limit of the design, pinned so it cannot drift into being
  // an accident: with the raw buffer ON the tail is not prefix-cut, because the
  // stored copy — not the shown prefix — is what consumes the slice, and
  // cutting to the OLDEST turns would cost the extractor the most actionable
  // content for a resumability that would then never be used. So a slice whose
  // own segments are pruned back out (#139) still holds, and it is the raw
  // buffer, not the resume points, that has to give way.
  it("keeps showing the NEWEST turns with the raw buffer on, and still holds when its segments are pruned", async () => {
    const full = oversizedConversation();
    const shown: string[] = [];
    const consolidator: Consolidator = {
      async extract(input) {
        shown.push(input.transcriptTail ?? "");
        return [];
      },
    };

    const stored = fakeStreamConversation(full, "conv-stored");
    const withRawBuffer = await consolidate({
      projectId,
      actor: "test",
      conversation: stored,
      consolidator,
      // Evicts all but one of this boundary's own chunks, so "stored WHOLE" is
      // false — the only other way to consume the slice.
      segmentRetention: { maxCount: 1 },
    });
    expect(withRawBuffer.segmentsWritten).toBeGreaterThan(1);
    expect(withRawBuffer.conversationSliceHeld).toBe(true);
    // The turns nearest the boundary, not the oldest ones.
    expect(shown[0]!.endsWith(full.slice(full.length - 200))).toBe(true);

    // Same slice, raw buffer off: now the tail is the only copy, so it is
    // reserved — and reserved as a resumable PREFIX, which drains.
    process.env.MEMORIZE_RAW_SEGMENTS = "0";
    const onlyCopy = fakeStreamConversation(full, "conv-only-copy");
    const drained = await consolidate({
      projectId,
      actor: "test",
      conversation: onlyCopy,
      consolidator,
    });
    expect(drained.conversationSliceHeld).toBe(false);
    expect(shown[1]!.startsWith(full.slice(0, 200))).toBe(true);
  });
});

describe("boundExtractionInput — resumable tail cut (#144)", () => {
  /** 50 short turns plus the turn-boundary prefix lengths inside them. */
  function turnsWithResumePoints(): { text: string; prefixes: number[] } {
    const text = Array.from({ length: 50 }, (_, i) => `USER: turn ${i} ${"x".repeat(30)}`).join(
      "\n\n",
    );
    const prefixes: number[] = [];
    for (let i = text.indexOf("\n\n"); i !== -1; i = text.indexOf("\n\n", i + 1)) {
      if (i + 2 < text.length) prefixes.push(i + 2);
    }
    return { text, prefixes };
  }

  it("keeps the OLDEST prefix ending on a resume point, within an injected budget", () => {
    const { text, prefixes } = turnsWithResumePoints();
    const maxChars = 900;

    const bounded = boundExtractionInput(
      { observations: [], existingMemories: [], transcriptTail: text },
      { maxChars, tailResumePrefixes: prefixes },
    );

    expect(bounded.transcriptTailCoverage).toBe("prefix");
    expect(prefixes).toContain(bounded.transcriptTailPrefixChars);
    // The shown tail STARTS the conversation — the cut is a prefix, so what it
    // leaves out is the newer end, which the next boundary re-reads.
    const kept = bounded.transcriptTailPrefixChars!;
    expect(bounded.transcriptTail!.startsWith(text.slice(0, kept))).toBe(true);
    expect(buildExtractionUserContent(bounded).length).toBeLessThanOrEqual(maxChars);
    // Largest fitting point: the next one up overruns the budget. Read the
    // trim marker off the result rather than restating it, so this stays a
    // statement about the CUT and not about the marker's wording.
    const marker = bounded.transcriptTail!.slice(kept);
    const next = prefixes[prefixes.indexOf(kept) + 1]!;
    expect(
      buildExtractionUserContent({
        observations: [],
        existingMemories: [],
        transcriptTail: `${text.slice(0, next)}${marker}`,
      }).length,
    ).toBeGreaterThan(maxChars);
  });

  it("falls back to the newest-suffix clip when the source declares no resume points", () => {
    const { text } = turnsWithResumePoints();

    const bounded = boundExtractionInput(
      { observations: [], existingMemories: [], transcriptTail: text },
      { maxChars: 900 },
    );

    expect(bounded.transcriptTailCoverage).toBe("clipped");
    expect(bounded.transcriptTailPrefixChars).toBeUndefined();
    expect(bounded.transcriptTail!.endsWith(text.slice(text.length - 100))).toBe(true);
  });

  it("shows nothing when not even the smallest resume point fits", () => {
    const { text, prefixes } = turnsWithResumePoints();

    const bounded = boundExtractionInput(
      { observations: [], existingMemories: [], transcriptTail: text },
      { maxChars: 200, tailResumePrefixes: prefixes },
    );

    expect(bounded.transcriptTailCoverage).not.toBe("prefix");
    expect(bounded.transcriptTailPrefixChars).toBeUndefined();
  });
});

describe("resumePointsOf (#144)", () => {
  const slice = (points: Array<{ chars: number; offset: number }>): ConversationSlice => ({
    text: "a".repeat(100),
    newOffset: 1000,
    resumePoints: points,
  });

  it("keeps in-range forward points, sorted by prefix length", () => {
    expect([
      ...resumePointsOf(
        slice([
          { chars: 60, offset: 960 },
          { chars: 20, offset: 920 },
        ]),
        900,
      ),
    ]).toEqual([
      [20, 920],
      [60, 960],
    ]);
  });

  it("drops points outside the text, past the slice, or not moving forward", () => {
    expect([
      ...resumePointsOf(
        slice([
          { chars: 0, offset: 950 },
          { chars: 100, offset: 950 },
          { chars: 150, offset: 950 },
          { chars: 10.5, offset: 950 },
          { chars: 30, offset: 1001 },
          { chars: 40, offset: 900 },
          { chars: 50, offset: 950 },
        ]),
        900,
      ),
    ]).toEqual([[50, 950]]);
  });

  // A `ConversationSource` is harness code and may be plain JS or JSON-backed,
  // so a malformed ELEMENT has to degrade the same way a malformed `resumePoints`
  // does: dropped individually, never dereferenced into a thrown boundary.
  it("drops non-object entries without throwing, keeping the valid ones", () => {
    const points = [null, undefined, 42, "50", { chars: 50, offset: 950 }] as unknown as Array<{
      chars: number;
      offset: number;
    }>;
    expect([...resumePointsOf(slice(points), 900)]).toEqual([[50, 950]]);
  });

  // The one shape the old `offset <= newOffset` bound let through: a point
  // INSIDE the text carrying the cursor for the WHOLE slice. Committing it
  // would consume `text.slice(chars)` while only the prefix was ever shown —
  // exactly the loss #136 closed.
  it("drops an internal point that declares the slice's terminal offset", () => {
    expect([...resumePointsOf(slice([{ chars: 50, offset: 1000 }]), 900)]).toEqual([]);
  });

  it("drops a point whose offset goes backwards relative to a shorter prefix", () => {
    expect([
      ...resumePointsOf(
        slice([
          { chars: 20, offset: 960 },
          { chars: 60, offset: 930 },
          { chars: 80, offset: 980 },
        ]),
        900,
      ),
    ]).toEqual([
      [20, 960],
      [80, 980],
    ]);
  });
});

// #139 (PR #102 Codex P2, judged real on PR #136): the event watermark and
// the conversation offset used to be two independent `writeMeta` calls in
// `run()`'s commit tail — a crash between them left the event watermark
// advanced with the conversation offset still behind, so the next boundary
// re-read the same slice under a fresh (already-consumed) observation window
// and re-extracted it into a duplicate memory.
describe("consolidate — atomic boundary cursor commit (#139)", () => {
  it("advances both cursors from one boundary that has both an observation and a conversation slice", async () => {
    await seedObservation("decided x");
    const conversation = fakeConversation([
      { text: "USER: hi", newOffset: 50, resumePoints: [] },
      { text: "USER: later", newOffset: 90, resumePoints: [] },
    ]);

    expect(getConsolidateWatermark(projectId)).toBeUndefined();
    await consolidate({
      projectId,
      actor: "test",
      conversation,
      consolidator: {
        async extract() {
          return [];
        },
      },
    });

    expect(getConsolidateWatermark(projectId)).toBeDefined();
    await consolidate({
      projectId,
      actor: "test",
      conversation,
      consolidator: {
        async extract() {
          return [];
        },
      },
    });
    // The second boundary resumed from the offset the first one committed —
    // if the conversation offset had not advanced, this would read 0 again.
    expect(conversation.offsets).toEqual([0, 50]);
  });

  it("advances only the event watermark when there is no conversation source", async () => {
    await seedObservation("decided x");

    await consolidate({ projectId, actor: "test" });

    expect(getConsolidateWatermark(projectId)).toBeDefined();
    const offsetRows = getDb(projectId)
      .prepare("SELECT key FROM meta WHERE key LIKE 'cls_conversation_offset:%'")
      .all();
    expect(offsetRows).toEqual([]);
  });

  it("does not advance the event watermark on a conversation-only boundary with zero observations", async () => {
    const conversation = fakeConversation([
      { text: "USER: remember the plan", newOffset: 10, resumePoints: [] },
    ]);

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

    expect(result.observationsProcessed).toBe(0);
    expect(getConsolidateWatermark(projectId)).toBeUndefined();
    // The conversation offset DID advance — resuming reads from 10, not 0.
    const conversation2 = fakeConversation(
      [{ text: "USER: more", newOffset: 20, resumePoints: [] }],
      "conv-1",
    );
    await consolidate({ projectId, actor: "test", conversation: conversation2 });
    expect(conversation2.offsets).toEqual([10]);
  });

  // Owner's PR #162 review (2026-08-01 20:45): the existing CLIPPED-tail test
  // has no observations, so it only pins "conversation-only hold" — the same
  // shape as (b) above. It cannot tell whether the hold branch would also
  // wrongly suppress an otherwise-eligible watermark advance. This boundary
  // has both: an observation ready to advance the watermark, and a slice too
  // big to ever show whole (so the conversation cursor holds). The two must
  // commit together with only one of them moving.
  it("advances the event watermark but holds the conversation offset on a boundary with an observation and a CLIPPED tail", async () => {
    process.env.MEMORIZE_RAW_SEGMENTS = "0";
    await seedObservation("decided x");
    // One slice larger than the whole extraction budget: not even zero
    // memories make room for it, so no allocation policy can show it whole.
    const huge = Array.from({ length: 4000 }, (_, i) => `USER: line ${i}`).join("\n\n");
    const conversation = fakeConversation([
      { text: huge, newOffset: 512, resumePoints: [] },
      { text: `${huge}\n\nUSER: later`, newOffset: 900, resumePoints: [] },
    ]);
    const consolidator: Consolidator = {
      async extract() {
        return [];
      },
    };

    expect(getConsolidateWatermark(projectId)).toBeUndefined();
    const result = await consolidate({ projectId, actor: "test", conversation, consolidator });

    expect(result.conversationSliceHeld).toBe(true);
    expect(readLastConsolidateAttempt(projectId)?.conversationSliceHeld).toBe(true);
    expect(getConsolidateWatermark(projectId)).toBeDefined();

    // Re-read from 0: the conversation offset never committed, even though
    // the watermark did — the same atomic commit wrote one cursor and held
    // the other.
    await consolidate({ projectId, actor: "test", conversation, consolidator });
    expect(conversation.offsets).toEqual([0, 0]);
  });

  // Owner's 3rd comment on #139: `segmentsWritten > 0` alone (pre-#139) only
  // proved an insert happened, not that it survived `pruneSegments`, which
  // runs BEFORE the cursor-advance check in the same boundary. A slice whose
  // own chunks get pruned out from under it must not be treated as "stored".
  it("holds the conversation cursor when this slice's own segments are pruned within the same boundary", async () => {
    // One slice larger than the whole extraction budget, so it cannot be
    // shown WHOLE either — the only way it could advance the cursor is via
    // "stored WHOLE", which retention is about to falsify.
    const huge = Array.from({ length: 4000 }, (_, i) => `USER: line ${i}`).join("\n\n");
    const conversation = fakeConversation([
      { text: huge, newOffset: 512, resumePoints: [] },
      { text: `${huge}\n\nUSER: later`, newOffset: 900, resumePoints: [] },
    ]);
    const consolidator: Consolidator = {
      async extract() {
        return [];
      },
    };

    const result = await consolidate({
      projectId,
      actor: "test",
      conversation,
      consolidator,
      // Forces pruneSegments to evict all but the single newest chunk this
      // boundary just inserted — the disjointness check must catch that.
      segmentRetention: { maxCount: 1 },
    });

    expect(result.segmentsWritten).toBeGreaterThan(1);
    expect(listSegments(projectId)).toHaveLength(1);
    expect(result.conversationSliceHeld).toBe(true);
    expect(readLastConsolidateAttempt(projectId)?.conversationSliceHeld).toBe(true);

    await consolidate({ projectId, actor: "test", conversation, consolidator });
    // Re-read from 0: the slice's own segments were pruned, so it was never
    // durably stored — same as the CLIPPED-and-unstored case, the cursor did
    // not move.
    expect(conversation.offsets).toEqual([0, 0]);
  });

  it("still advances the cursor when retention prunes OTHER, older segments — not this slice's own", async () => {
    // Filler segments old enough for pruneSegments' default age cutoff (30
    // days) to delete them on their own, independent of this boundary's
    // chunks. Their ids never appear in `storedSegmentIds`, so the
    // disjointness check must not treat their removal as touching this slice.
    insertSegments(projectId, [
      { id: "seg_filler_1", createdAt: "2020-01-01T00:00:00.000Z", ordinal: 0, text: "old 1" },
      { id: "seg_filler_2", createdAt: "2020-01-01T00:00:00.000Z", ordinal: 1, text: "old 2" },
    ]);
    const conversation = fakeConversation([
      { text: "USER: stored verbatim instead", newOffset: 512, resumePoints: [] },
      { text: "USER: next", newOffset: 900, resumePoints: [] },
    ]);
    const consolidator: Consolidator = {
      async extract() {
        return [];
      },
    };

    const first = await consolidate({ projectId, actor: "test", conversation, consolidator });
    expect(first.segmentsWritten).toBeGreaterThan(0);
    expect(first.conversationSliceHeld).toBe(false);
    // The old filler was pruned (age-based, default retention); this
    // boundary's own segments were not.
    expect(listSegments(projectId).some((s) => s.id === "seg_filler_1")).toBe(false);
    expect(listSegments(projectId).some((s) => s.id === "seg_filler_2")).toBe(false);

    await consolidate({ projectId, actor: "test", conversation, consolidator });
    expect(conversation.offsets).toEqual([0, 512]);
  });

  it("rolls back the event watermark when the conversation-offset write fails, so neither cursor advances", async () => {
    await seedObservation("decided x");
    const conversation = fakeConversation([
      { text: "USER: hi", newOffset: 50, resumePoints: [] },
      { text: "USER: hi", newOffset: 50, resumePoints: [] },
    ]);
    const consolidator: Consolidator = {
      async extract() {
        return [];
      },
    };

    // Simulates a crash/failure of the SECOND cursor write inside the same
    // transaction commitBoundaryCursors opens — a real crash can't be
    // injected from a test, so this forces the same failure point via a
    // trigger on the shared `meta` table the two cursors are written to.
    const db = getDb(projectId);
    db.exec(
      "CREATE TRIGGER mori_test_boom_139 BEFORE INSERT ON meta " +
        "WHEN NEW.key LIKE 'cls_conversation_offset:%' " +
        "BEGIN SELECT RAISE(ABORT, 'injected #139 test failure'); END;",
    );

    await expect(
      consolidate({ projectId, actor: "test", conversation, consolidator }),
    ).rejects.toThrow(/injected #139 test failure/);

    // The event watermark write was in the SAME transaction as the offset
    // write that threw — if the two were still independent writes, this
    // would be defined (the pre-#139 bug PR #102's Codex review flagged).
    expect(getConsolidateWatermark(projectId)).toBeUndefined();

    db.exec("DROP TRIGGER mori_test_boom_139");
    await consolidate({ projectId, actor: "test", conversation, consolidator });
    // Resumes from offset 0 on both the failed and the retried attempt — the
    // conversation offset was never committed either.
    expect(conversation.offsets).toEqual([0, 0]);
    expect(getConsolidateWatermark(projectId)).toBeDefined();
  });
});

// Codex P2 on PR #136: the extractor sees `bounded.existingMemories`, so a
// supersedes id naming a memory the budget trimmed away cannot have been
// judged by the model that emitted it.
describe("consolidate — supersedes only what the extractor was shown (#113)", () => {
  it("ignores a supersedes id for a memory the input budget trimmed away", async () => {
    const trimmed = createConsolidatedMemory({
      projectId,
      kind: "decision",
      text: "the oldest memory, trimmed out of the prompt",
      salience: 5,
    });
    await appendEvent({
      type: "memory.consolidated",
      projectId,
      scopeType: "session",
      scopeId: projectId,
      actor: "test",
      payload: trimmed,
    });
    // Push it out of the budget with a large, newer valid-memory history.
    for (let i = 0; i < 300; i++) {
      await appendEvent({
        type: "memory.consolidated",
        projectId,
        scopeType: "session",
        scopeId: projectId,
        actor: "test",
        payload: createConsolidatedMemory({
          projectId,
          kind: "progress",
          text: `filler memory ${i} `.repeat(20),
          salience: 5,
        }),
      });
    }
    await seedObservation("decided something new");
    // `appendEvent` writes the log only; without this the memory section
    // `consolidate` reads would be empty and the trim under test fictional.
    await rebuildProjectProjection(projectId, { reindexSearch: false });

    const consolidator: Consolidator = {
      async extract(input) {
        expect(input.existingMemories.length).toBeGreaterThan(0);
        expect(input.existingMemories.some((m) => m.id === trimmed.id)).toBe(false);
        return [
          {
            kind: "decision",
            text: "a new decision",
            salience: 6,
            supersedesMemoryId: trimmed.id,
            supersedeReason: "injected",
          },
        ];
      },
    };

    const result = await consolidate({ projectId, actor: "test", consolidator });

    expect(result.superseded).toBe(0);
    const events = await readEvents(projectId);
    expect(events.filter((e) => e.type === "memory.superseded")).toHaveLength(0);
    expect(listValidMemories(projectId).map((r) => r.memory.id)).toContain(trimmed.id);
  });
});

// Codex P2 on PR #136: a batch mixing path-carrying and legacy/pathless write
// observations reported only the paths, so "Edited 1 file(s)" could stand for
// a window of many more edits.
describe("consolidate — fallback edit count never under-claims a mixed batch (#113)", () => {
  it("reports the edit count when some write observations carry no path", async () => {
    for (const filePath of ["/repo/src/a.ts", undefined, undefined, undefined]) {
      const observation = createObservation({
        projectId,
        signal: "write-tool",
        toolName: "Edit",
        summary: "Edit: something",
        ...(filePath ? { filePath } : {}),
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
    expect(texts).toContain("Made 4 file edit(s)");
    expect(texts.some((t) => t.includes("Edited 1 file(s)"))).toBe(false);
  });
});

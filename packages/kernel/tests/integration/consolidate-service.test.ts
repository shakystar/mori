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
  CONSERVATIVE_CHARS_PER_TOKEN,
  ExtractionParseError,
  MAX_EXTRACTION_INPUT_CHARS,
  boundExtractionInput,
  buildExtractionUserContent,
  chunkConversation,
  consolidate,
  extractionCharBudget,
  getConsolidateWatermark,
  getConsolidationStatus,
  parseExtractedMemories,
  readLastConsolidateAttempt,
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
describe("extractionCharBudget — model-aware extraction budget (#143)", () => {
  it("falls back to MAX_EXTRACTION_INPUT_CHARS when the LLM declares no context window", () => {
    expect(extractionCharBudget(undefined)).toBe(MAX_EXTRACTION_INPUT_CHARS);
    expect(extractionCharBudget({ complete: async () => "[]" })).toBe(MAX_EXTRACTION_INPUT_CHARS);
  });

  it("derives a strictly smaller budget from a small declared context window", () => {
    const budget = extractionCharBudget({ complete: async () => "[]", contextWindowTokens: 4_000 });
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThan(MAX_EXTRACTION_INPUT_CHARS);
  });

  it("keeps the estimated prompt tokens (system + rendered user content) within a small declared context window, for a dense CJK backlog", async () => {
    // CJK observation content: no spaces, so this stresses the same axis the
    // issue calls out — many tokens per character relative to English.
    const cjk = "가".repeat(6_000);
    await seedObservation(cjk, "decision-keyword");

    const llm = fakeLlmWithContext(4_000, ["[]"]);
    await consolidate({ projectId, actor: "test", llm });

    expect(llm.prompts.length).toBe(1);
    const estimatedTokens = Math.ceil(llm.prompts[0]!.length / CONSERVATIVE_CHARS_PER_TOKEN);
    expect(estimatedTokens).toBeLessThanOrEqual(4_000);
  });

  it("still guarantees at least one observation per boundary and drains the backlog under a narrow declared window", async () => {
    const bigSummary = "y".repeat(2000);
    const total = 8;
    for (let i = 0; i < total; i++) {
      await seedObservation(`${bigSummary} #${i}`, "decision-keyword");
    }

    const llm = fakeLlmWithContext(4_000, Array(total).fill("[]"));

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
      { text: "USER: this must not vanish", newOffset: 512 },
      { text: "USER: this must not vanish\n\nUSER: more", newOffset: 900 },
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
      { text: "USER: stored verbatim instead", newOffset: 512 },
      { text: "USER: next", newOffset: 900 },
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
      { text: sliceText("first"), newOffset: 512 },
      { text: sliceText("second"), newOffset: 900 },
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
      { text: huge, newOffset: 512 },
      { text: `${huge}\n\nUSER: later`, newOffset: 900 },
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
      { text: "", newOffset: 77 },
      { text: "", newOffset: 88 },
    ]);

    await consolidate({ projectId, actor: "test", conversation });
    await consolidate({ projectId, actor: "test", conversation });

    expect(conversation.offsets).toEqual([0, 77]);
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
      { text: "USER: hi", newOffset: 50 },
      { text: "USER: later", newOffset: 90 },
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

    expect(result.observationsProcessed).toBe(0);
    expect(getConsolidateWatermark(projectId)).toBeUndefined();
    // The conversation offset DID advance — resuming reads from 10, not 0.
    const conversation2 = fakeConversation([{ text: "USER: more", newOffset: 20 }], "conv-1");
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
      { text: huge, newOffset: 512 },
      { text: `${huge}\n\nUSER: later`, newOffset: 900 },
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
      { text: huge, newOffset: 512 },
      { text: `${huge}\n\nUSER: later`, newOffset: 900 },
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
      { text: "USER: stored verbatim instead", newOffset: 512 },
      { text: "USER: next", newOffset: 900 },
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
      { text: "USER: hi", newOffset: 50 },
      { text: "USER: hi", newOffset: 50 },
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

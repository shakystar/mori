import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadQuestions } from "./loader.js";
import { abilityForQuestion, MEMORY_ABILITIES } from "./types.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("longmemeval-v1 loader (#507)", () => {
  it("parses all 6 question_type values plus abstention from the fixed fixture", async () => {
    const questions = await loadQuestions(FIXTURES_DIR, "questions.json");
    expect(
      questions.map((q) => ({
        id: q.id,
        questionType: q.questionType,
        ability: q.ability,
        isAbstention: q.isAbstention,
      })),
    ).toEqual([
      {
        id: "fx-q1",
        questionType: "single-session-user",
        ability: MEMORY_ABILITIES.informationExtraction,
        isAbstention: false,
      },
      {
        id: "fx-q2_abs",
        questionType: "single-session-user",
        ability: MEMORY_ABILITIES.abstention,
        isAbstention: true,
      },
      {
        id: "fx-q3",
        questionType: "single-session-preference",
        ability: MEMORY_ABILITIES.informationExtraction,
        isAbstention: false,
      },
      {
        id: "fx-q4",
        questionType: "multi-session",
        ability: MEMORY_ABILITIES.multiSessionReasoning,
        isAbstention: false,
      },
      {
        id: "fx-q5",
        questionType: "knowledge-update",
        ability: MEMORY_ABILITIES.knowledgeUpdates,
        isAbstention: false,
      },
      {
        id: "fx-q6",
        questionType: "temporal-reasoning",
        ability: MEMORY_ABILITIES.temporalReasoning,
        isAbstention: false,
      },
      {
        id: "fx-q7",
        questionType: "single-session-assistant",
        ability: MEMORY_ABILITIES.informationExtraction,
        isAbstention: false,
      },
      {
        id: "fx-q8",
        questionType: "multi-session",
        ability: MEMORY_ABILITIES.multiSessionReasoning,
        isAbstention: false,
      },
      {
        id: "fx-q9",
        questionType: "single-session-user",
        ability: MEMORY_ABILITIES.informationExtraction,
        isAbstention: false,
      },
    ]);
  });

  it("keeps haystack sessions index-aligned and tolerates a session id replayed at a different position", async () => {
    const questions = await loadQuestions(FIXTURES_DIR, "questions.json");
    const q3 = questions.find((q) => q.id === "fx-q3");
    expect(q3?.haystackSessions.map((s) => s.sessionId)).toEqual([
      "fx-sess-d",
      "fx-sess-e",
      "fx-sess-d",
    ]);
    // Same session id, different date, same turn content — a real pattern observed in the
    // upstream longmemeval_s_cleaned.json (13/500 questions), not a loader bug.
    expect(q3?.haystackSessions[0]?.date).not.toEqual(q3?.haystackSessions[2]?.date);
    expect(q3?.haystackSessions[0]?.turns).toEqual(q3?.haystackSessions[2]?.turns);
  });

  it("marks has_answer on the evidence turn, false on the rest of a labeled session, and leaves it unset on a filler session", async () => {
    const questions = await loadQuestions(FIXTURES_DIR, "questions.json");
    const q1 = questions.find((q) => q.id === "fx-q1");
    expect(q1?.haystackSessions[0]?.turns[0]?.hasAnswer).toBe(true);
    expect(q1?.haystackSessions[0]?.turns[1]?.hasAnswer).toBe(false);
    expect(q1?.haystackSessions[1]?.turns[0]?.hasAnswer).toBeUndefined();
  });

  it("abilityForQuestion fails loudly on an unrecognized question_type", () => {
    expect(() => abilityForQuestion("not-a-real-type", "fx-unknown")).toThrow(
      /알 수 없는 question_type/,
    );
  });

  it("abilityForQuestion scores an _abs-suffixed id as abstention regardless of its base type", () => {
    expect(abilityForQuestion("multi-session", "abc123_abs")).toBe(MEMORY_ABILITIES.abstention);
  });

  it("abilityForQuestion fails loudly on an unrecognized question_type even for an _abs id", () => {
    expect(() => abilityForQuestion("not-a-real-type", "fx-unknown_abs")).toThrow(
      /알 수 없는 question_type/,
    );
  });

  it("coerces a bare JSON number answer (real dataset quirk on some multi-session counting questions) to a string", async () => {
    const questions = await loadQuestions(FIXTURES_DIR, "questions.json");
    const q8 = questions.find((q) => q.id === "fx-q8");
    expect(q8?.answer).toBe("2");
  });

  it("preserves an empty-string turn content (real dataset quirk: 12/246,750 turns are blank messages)", async () => {
    const questions = await loadQuestions(FIXTURES_DIR, "questions.json");
    const q9 = questions.find((q) => q.id === "fx-q9");
    expect(q9?.haystackSessions[0]?.turns[0]?.content).toBe("");
  });
});

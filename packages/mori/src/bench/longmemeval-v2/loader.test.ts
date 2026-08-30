import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadQuestions, loadTrajectories } from "./loader.js";
import { MEMORY_ABILITIES } from "./types.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("longmemeval-v2 loader (#490)", () => {
  it("parses ability labels and session boundaries from the fixed 3-question/2-trajectory fixture", async () => {
    const questions = await loadQuestions(FIXTURES_DIR);
    expect(
      questions.map((q) => ({ id: q.id, questionType: q.questionType, ability: q.ability })),
    ).toEqual([
      {
        id: "fx-q1",
        questionType: "static-environment",
        ability: MEMORY_ABILITIES.staticStateRecall,
      },
      {
        id: "fx-q2",
        questionType: "dynamic-environment-abs",
        ability: MEMORY_ABILITIES.premiseAwareness,
      },
      { id: "fx-q3", questionType: "errors-gotchas", ability: MEMORY_ABILITIES.environmentGotchas },
    ]);

    const trajectories = await loadTrajectories(FIXTURES_DIR);
    expect(
      trajectories.map((t) => ({ id: t.id, domain: t.domain, stateCount: t.states.length })),
    ).toEqual([
      { id: "fx-traj-1", domain: "web", stateCount: 2 },
      { id: "fx-traj-2", domain: "enterprise", stateCount: 1 },
    ]);
    // Session boundary: each trajectory's states are its own, in order from 0 — the two
    // fixture sessions don't bleed into each other.
    expect(trajectories[0]?.states.map((s) => s.stateIndex)).toEqual([0, 1]);
    expect(trajectories[1]?.states.map((s) => s.stateIndex)).toEqual([0]);
  });
});

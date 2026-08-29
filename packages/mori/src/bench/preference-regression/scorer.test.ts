import { describe, expect, it } from "vitest";
import { scoreBehavioralAdaptation, type LlmJudge, type ScoredScenario } from "./scorer.js";

describe("scoreBehavioralAdaptation (#386)", () => {
  it("scores an all-deterministic rubric without needing a judge", async () => {
    const scenario: ScoredScenario = {
      id: "det-only",
      rubric: [
        {
          kind: "deterministic",
          id: "contains-foo",
          description: "출력에 foo가 있다",
          check: (output) => output.includes("foo"),
        },
        {
          kind: "deterministic",
          id: "contains-bar",
          description: "출력에 bar가 있다",
          check: (output) => output.includes("bar"),
        },
      ],
    };

    const result = await scoreBehavioralAdaptation(scenario, "foo but no b-word");

    expect(result.scenarioId).toBe("det-only");
    expect(result.criteria).toEqual([
      {
        id: "contains-foo",
        description: "출력에 foo가 있다",
        kind: "deterministic",
        satisfied: true,
      },
      {
        id: "contains-bar",
        description: "출력에 bar가 있다",
        kind: "deterministic",
        satisfied: false,
      },
    ]);
    expect(result.score).toBe(0.5);
  });

  it("throws when an llm-judge criterion is present but no judge is injected", async () => {
    const scenario: ScoredScenario = {
      id: "needs-judge",
      rubric: [
        {
          kind: "llm-judge",
          id: "is-nice",
          description: "출력이 친절한가",
          question: "이 출력이 친절한 어조인가?",
        },
      ],
    };

    await expect(scoreBehavioralAdaptation(scenario, "output text")).rejects.toThrow(
      /needs-judge.*is-nice.*judge/,
    );
  });

  it("delegates llm-judge criteria to the injected judge and never calls a real model", async () => {
    const seenCalls: Array<{ question: string; output: string }> = [];
    // Zero network/model calls — this fake judge is a plain in-process function, per #386's
    // "테스트 실행 중 네트워크/실제 모델 호출 0건" completion condition.
    const fakeJudge: LlmJudge = {
      judge(question, followUpOutput) {
        seenCalls.push({ question, output: followUpOutput });
        return Promise.resolve(followUpOutput.includes("concise"));
      },
    };
    const scenario: ScoredScenario = {
      id: "mixed",
      rubric: [
        {
          kind: "deterministic",
          id: "short",
          description: "짧다",
          check: (output) => output.length < 50,
        },
        {
          kind: "llm-judge",
          id: "reads-concise",
          description: "간결하게 읽히는가",
          question: "이 응답이 간결한가?",
        },
      ],
    };

    const result = await scoreBehavioralAdaptation(scenario, "a concise reply", fakeJudge);

    expect(seenCalls).toEqual([{ question: "이 응답이 간결한가?", output: "a concise reply" }]);
    expect(result.criteria).toEqual([
      { id: "short", description: "짧다", kind: "deterministic", satisfied: true },
      { id: "reads-concise", description: "간결하게 읽히는가", kind: "llm-judge", satisfied: true },
    ]);
    expect(result.score).toBe(1);
  });

  it("reports an empty rubric as score 0, not a division-by-zero NaN or a false 'fully adapted'", async () => {
    const result = await scoreBehavioralAdaptation({ id: "empty", rubric: [] }, "anything");

    expect(result.criteria).toEqual([]);
    expect(result.score).toBe(0);
  });

  it("excludes an 'inconclusive' deterministic criterion from score instead of counting it as a failure (#475)", async () => {
    const scenario: ScoredScenario = {
      id: "with-inconclusive",
      rubric: [
        {
          kind: "deterministic",
          id: "no-evidence",
          description: "잴 증거가 없으면 판정 불가",
          check: () => "inconclusive",
        },
        {
          kind: "deterministic",
          id: "contains-bar",
          description: "출력에 bar가 있다",
          check: (output) => output.includes("bar"),
        },
      ],
    };

    const result = await scoreBehavioralAdaptation(scenario, "bar only");

    expect(result.criteria).toEqual([
      {
        id: "no-evidence",
        description: "잴 증거가 없으면 판정 불가",
        kind: "deterministic",
        satisfied: "inconclusive",
      },
      {
        id: "contains-bar",
        description: "출력에 bar가 있다",
        kind: "deterministic",
        satisfied: true,
      },
    ]);
    // "no-evidence"는 분자·분모 양쪽에서 빠지므로 남은 기준(contains-bar) 하나만으로 1/1 = 1이다
    // — 판정 불가가 실패로 섞이면 1/2 = 0.5가 됐을 것이다.
    expect(result.score).toBe(1);
  });

  it("scores 0, not NaN, when every deterministic criterion is inconclusive", async () => {
    const scenario: ScoredScenario = {
      id: "all-inconclusive",
      rubric: [
        {
          kind: "deterministic",
          id: "no-evidence",
          description: "잴 증거가 없으면 판정 불가",
          check: () => "inconclusive",
        },
      ],
    };

    const result = await scoreBehavioralAdaptation(scenario, "anything");

    expect(result.score).toBe(0);
  });
});

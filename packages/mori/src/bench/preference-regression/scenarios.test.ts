import { describe, expect, it } from "vitest";
import { PREFERENCE_REGRESSION_SCENARIOS } from "./scenarios.js";
import { scoreBehavioralAdaptation, type LlmJudge } from "./scorer.js";

const ALWAYS_TRUE_JUDGE: LlmJudge = { judge: () => Promise.resolve(true) };

describe("PREFERENCE_REGRESSION_SCENARIOS (#386)", () => {
  it("defines a small, uniquely-identified scenario set", () => {
    expect(PREFERENCE_REGRESSION_SCENARIOS.length).toBeGreaterThanOrEqual(3);
    const ids = PREFERENCE_REGRESSION_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(PREFERENCE_REGRESSION_SCENARIOS.map((s) => [s.id, s] as const))(
    "%s has non-empty context turns, a follow-up prompt, and a non-empty rubric with unique criterion ids",
    (_id, scenario) => {
      expect(scenario.contextTurns.length).toBeGreaterThan(0);
      for (const turn of scenario.contextTurns) expect(turn.trim().length).toBeGreaterThan(0);
      expect(scenario.followUpPrompt.trim().length).toBeGreaterThan(0);

      expect(scenario.rubric.length).toBeGreaterThan(0);
      const criterionIds = scenario.rubric.map((c) => c.id);
      expect(new Set(criterionIds).size).toBe(criterionIds.length);
    },
  );

  it.each(PREFERENCE_REGRESSION_SCENARIOS.map((s) => [s.id, s] as const))(
    "%s never states impliedPreference verbatim in the context turns or follow-up prompt (leniency-trap guard, #340 기준 3)",
    (_id, scenario) => {
      const sessionText = [...scenario.contextTurns, scenario.followUpPrompt].join("\n");
      expect(sessionText).not.toContain(scenario.impliedPreference);
    },
  );

  it("tabs-indentation: scores 1 on tab-indented output and less than 1 on space-indented output", async () => {
    const scenario = PREFERENCE_REGRESSION_SCENARIOS.find((s) => s.id === "tabs-indentation");
    if (!scenario) throw new Error("tabs-indentation scenario missing");

    const tabOutput = "```ts\nfunction concat(a: string, b: string) {\n\treturn a + b;\n}\n```";
    const spaceOutput = "```ts\nfunction concat(a: string, b: string) {\n  return a + b;\n}\n```";

    const tabScore = await scoreBehavioralAdaptation(scenario, tabOutput, ALWAYS_TRUE_JUDGE);
    const spaceScore = await scoreBehavioralAdaptation(scenario, spaceOutput, ALWAYS_TRUE_JUDGE);

    expect(tabScore.score).toBe(1);
    expect(spaceScore.score).toBeLessThan(1);
  });

  it("concise-responses: scores 1 on a short reply and less than 1 on a long one", async () => {
    const scenario = PREFERENCE_REGRESSION_SCENARIOS.find((s) => s.id === "concise-responses");
    if (!scenario) throw new Error("concise-responses scenario missing");

    const shortOutput = "유니언은 OR, 인터섹션은 AND로 타입을 합친다.";
    const longOutput = "좋은 질문이에요! ".repeat(30);

    const shortScore = await scoreBehavioralAdaptation(scenario, shortOutput, ALWAYS_TRUE_JUDGE);
    const longScore = await scoreBehavioralAdaptation(scenario, longOutput, ALWAYS_TRUE_JUDGE);

    expect(shortScore.score).toBe(1);
    expect(longScore.score).toBeLessThan(1);
  });

  it("concise-responses: short-response ignores fenced code length so a minimal example doesn't sink an otherwise concise answer (#459)", async () => {
    // #459 실측(docs/bench/preference-regression-3arm-run-2026-08-14.md §1·§6-1) — ORACLE조차
    // 최소 코드 예시 하나 때문에 200자를 넘겨 이 기준에서 0점을 받았다(전문 278자). 코드
    // 펜스를 뺀 산문 길이로 재면 이 케이스는 통과해야 하고, 코드 없이도 장황한 응답은 여전히
    // 걸려야 한다.
    const scenario = PREFERENCE_REGRESSION_SCENARIOS.find((s) => s.id === "concise-responses");
    if (!scenario) throw new Error("concise-responses scenario missing");

    const conciseWithCode =
      "유니언(합집합): `A | B` — A 또는 B 중 하나의 타입.\n\n" +
      "인터섹션(교집합): `A & B` — A와 B의 모든 속성을 가진 타입.\n\n" +
      "```ts\n" +
      "type A = { a: number };\n" +
      "type B = { b: string };\n\n" +
      "const u: A | B = { a: 1 };  // OK\n" +
      'const i: A & B = { a: 1, b: "x" }; // 둘 다 필요\n' +
      "```";
    const verboseNoCode = "핵심은요, ".repeat(40);

    const conciseScore = await scoreBehavioralAdaptation(
      scenario,
      conciseWithCode,
      ALWAYS_TRUE_JUDGE,
    );
    const verboseScore = await scoreBehavioralAdaptation(
      scenario,
      verboseNoCode,
      ALWAYS_TRUE_JUDGE,
    );

    expect(conciseWithCode.trim().length).toBeGreaterThan(200); // 전문은 여전히 200자를 넘는다.
    expect(conciseScore.score).toBe(1);
    expect(verboseScore.score).toBeLessThan(1);
  });

  it("pnpm-workflow: scores 1 on pnpm-only output and less than 1 when npm is mixed in", async () => {
    const scenario = PREFERENCE_REGRESSION_SCENARIOS.find((s) => s.id === "pnpm-workflow");
    if (!scenario) throw new Error("pnpm-workflow scenario missing");

    const pnpmOutput = "pnpm add lodash\n\nCI: pnpm install --frozen-lockfile && pnpm build";
    const npmOutput = "npm install lodash\n\nCI: npm ci && npm run build";

    const pnpmScore = await scoreBehavioralAdaptation(scenario, pnpmOutput, ALWAYS_TRUE_JUDGE);
    const npmScore = await scoreBehavioralAdaptation(scenario, npmOutput, ALWAYS_TRUE_JUDGE);

    expect(pnpmScore.score).toBe(1);
    expect(npmScore.score).toBeLessThan(1);
  });

  it("pnpm-workflow: scores less than 1 when pnpm install is mixed with npm CI steps", async () => {
    const scenario = PREFERENCE_REGRESSION_SCENARIOS.find((s) => s.id === "pnpm-workflow");
    if (!scenario) throw new Error("pnpm-workflow scenario missing");

    const mixedOutput = "pnpm add lodash\n\nCI: npm ci && npm run build";
    const mixedScore = await scoreBehavioralAdaptation(scenario, mixedOutput, ALWAYS_TRUE_JUDGE);

    expect(mixedScore.score).toBeLessThan(1);
  });
});

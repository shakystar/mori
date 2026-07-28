import { describe, expect, it } from "vitest";

describe("ci smoke (temporary)", () => {
  it("is deliberately broken to verify CI goes red", () => {
    expect(1).toBe(2);
  });
});

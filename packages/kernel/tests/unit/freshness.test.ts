import { describe, expect, it } from "vitest";

import { freshnessLabel } from "../../src/services/freshness.js";

const NOW = new Date("2026-06-15T12:00:00.000Z");

function minutesAgo(mins: number): string {
  return new Date(NOW.getTime() - mins * 60_000).toISOString();
}

describe("freshnessLabel", () => {
  it("labels < 5m and future timestamps as active just now", () => {
    expect(freshnessLabel(minutesAgo(0), NOW)).toBe("active just now");
    expect(freshnessLabel(minutesAgo(4), NOW)).toBe("active just now");
    expect(freshnessLabel(minutesAgo(-5), NOW)).toBe("active just now");
  });

  it("labels 5m–30m as active Nm ago", () => {
    expect(freshnessLabel(minutesAgo(5), NOW)).toBe("active 5m ago");
    expect(freshnessLabel(minutesAgo(29), NOW)).toBe("active 29m ago");
  });

  it("labels 30m–1h as stale ~Nm ago", () => {
    expect(freshnessLabel(minutesAgo(45), NOW)).toBe("stale ~45m ago");
  });

  it("labels 1h–4h as stale ~Nh ago", () => {
    expect(freshnessLabel(minutesAgo(90), NOW)).toBe("stale ~2h ago");
    expect(freshnessLabel(minutesAgo(239), NOW)).toBe("stale ~4h ago");
  });

  it("labels >= 4h as likely abandoned", () => {
    expect(freshnessLabel(minutesAgo(241), NOW)).toBe("stale (likely abandoned)");
  });

  it("defaults `now` to the current time when omitted", () => {
    expect(freshnessLabel(new Date().toISOString())).toBe("active just now");
  });
});

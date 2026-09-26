import { describe, expect, it } from "vitest";
import type { CodexDailyUsage, ProviderSnapshot } from "../types";
import { buildTodayQuotaAdvice, dailyUsageRatio } from "./todayQuota";

const weeklyReset = "2026-08-17T00:00:00.000Z";

function dailyUsage(observedUsedPercent = 3): CodexDailyUsage {
  return {
    localDate: "2026-08-13",
    observedUsedPercent,
    sampleCount: 2,
    firstObservedAt: "2026-08-13T00:10:00.000Z",
    lastObservedAt: "2026-08-13T08:00:00.000Z",
    coverage: "complete",
    source: "codex-session-rate-limits",
  };
}

const status = "ok" as ProviderSnapshot["status"];

describe("today quota advice", () => {
  it("expresses today's use as a ratio of the suggested daily share", () => {
    expect(dailyUsageRatio(24, 4.8)).toBe(500);
    expect(dailyUsageRatio(4.8, 4.8)).toBe(100);
    expect(dailyUsageRatio(4.8, 0)).toBeNull();
  });

  it("uses the official used percent and explains the remaining daily share", () => {
    const advice = buildTodayQuotaAdvice({
      status,
      rateLimitSnapshot: {
        source: "app-server",
        usedPercent: 20,
        windowDurationMins: 10_080,
        resetsAt: weeklyReset,
        observedAt: "2026-08-13T08:00:00.000Z",
      },
      weeklyWindow: { remainingPercent: 80, resetsAt: weeklyReset, windowSeconds: 604_800 },
      dailyUsage: dailyUsage(),
      now: new Date("2026-08-13T08:00:00.000Z"),
    });

    expect(advice.state).toBe("live");
    expect(advice.usedPercent).toBe(20);
    expect(advice.remainingPercent).toBe(80);
    expect(advice.todaySuggestedPercent).toBeCloseTo(10.9, 1);
    expect(advice.todayUsedPercent).toBe(3);
    expect(advice.todayRemainingPercent).toBeCloseTo(7.9, 1);
  });

  it("falls back to the legacy weekly window when the official snapshot is missing", () => {
    const advice = buildTodayQuotaAdvice({
      status,
      weeklyWindow: { remainingPercent: 70, resetsAt: weeklyReset, windowSeconds: 604_800 },
      dailyUsage: dailyUsage(1),
      now: new Date("2026-08-13T08:00:00.000Z"),
    });

    expect(advice.state).toBe("fallback");
    expect(advice.source).toBe("local-session");
    expect(advice.usedPercent).toBe(30);
    expect(advice.todayRemainingPercent).toBeGreaterThan(0);
  });

  it("keeps old values visibly stale instead of inventing a new suggestion", () => {
    const advice = buildTodayQuotaAdvice({
      status: "stale",
      rateLimitSnapshot: {
        source: "app-server",
        usedPercent: 60,
        windowDurationMins: 10_080,
        resetsAt: weeklyReset,
        observedAt: "2026-08-12T08:00:00.000Z",
      },
      dailyUsage: null,
      now: new Date("2026-08-13T08:00:00.000Z"),
    });

    expect(advice.state).toBe("stale");
    expect(advice.usedPercent).toBe(60);
    expect(advice.todaySuggestedPercent).toBeCloseTo(5.5, 1);
    expect(advice.todayRemainingPercent).toBeNull();
  });

  it("keeps the previous usage day until 4:00 and starts a new one at 4:00", () => {
    const beforeFour = buildTodayQuotaAdvice({
      status,
      weeklyWindow: { remainingPercent: 70, resetsAt: weeklyReset, windowSeconds: 604_800 },
      dailyUsage: dailyUsage(3),
      now: new Date(2026, 7, 14, 3, 59),
    });
    const atFour = buildTodayQuotaAdvice({
      status,
      weeklyWindow: { remainingPercent: 70, resetsAt: weeklyReset, windowSeconds: 604_800 },
      dailyUsage: dailyUsage(3),
      now: new Date(2026, 7, 14, 4, 0),
    });

    expect(beforeFour.todayUsedPercent).toBe(3);
    expect(atFour.todayUsedPercent).toBeNull();
  });

  it("returns missing advice when no official or local window exists", () => {
    const advice = buildTodayQuotaAdvice({ status: "unavailable", dailyUsage: null });
    expect(advice.state).toBe("missing");
    expect(advice.usedPercent).toBeNull();
    expect(advice.todaySuggestedPercent).toBeNull();
  });
});

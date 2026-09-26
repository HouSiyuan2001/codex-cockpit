import { describe, expect, it } from "vitest";
import type { DailyRecommendationRecord } from "../types";
import type { DailyRecommendation } from "./dynamicQuota";
import {
  applyPersonalUsageCalibration,
  calibratePersonalUsage,
  PERSONAL_USAGE_MIN_CALENDAR_DAYS,
  PERSONAL_USAGE_POLICY_VERSION,
} from "./personalUsageModel";

const DAY_MS = 86_400_000;

function dateKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function weekday(timestamp: number): number {
  return (new Date(timestamp).getUTCDay() + 6) % 7;
}

function fixture({
  days = 28,
  start = Date.UTC(2026, 6, 27),
  observed = (day: number) => day < 5 ? 24 : 2,
}: {
  days?: number;
  start?: number;
  observed?: (weekday: number, index: number) => number;
} = {}) {
  const observations = Array.from({ length: days }, (_, index) => {
    const timestamp = start + index * DAY_MS;
    const value = observed(weekday(timestamp), index);
    return {
      localDate: dateKey(timestamp),
      observedUsedPercent: value,
      sampleCount: value > 0 ? 4 : 0,
      coverage: value > 0 ? "complete" as const : "unavailable" as const,
      firstObservedAt: null,
      lastObservedAt: value > 0 ? new Date(timestamp + 12 * 60 * 60_000).toISOString() : null,
      source: "codex-session-rate-limits" as const,
    };
  });
  const recommendations: DailyRecommendationRecord[] = observations.map((item) => ({
    provider: "codex",
    localDate: item.localDate,
    targetPercent: 20,
    safetyCapPercent: 100,
    resetRiskPercent: 10,
    fatigueKneePercent: 25,
    carryInPercent: 0,
    policyVersion: "base",
    updatedAt: `${item.localDate}T12:00:00.000Z`,
  }));
  return { observations, recommendations };
}

function baseRecommendation(weekdayIndex: number): DailyRecommendation {
  return {
    targetPercent: 20,
    safetyCapPercent: 70,
    resetRiskPercent: 10,
    fatigueKneePercent: 25,
    carryInPercent: 0,
    futureDays: 5,
    cycleAge: 1,
    weekday: weekdayIndex,
    historySampleCount: 10,
    source: "remote-history",
    policyVersion: "base",
  };
}

describe("personal weekday usage calibration", () => {
  it("falls back until the local plan history spans at least three weeks", () => {
    const { observations, recommendations } = fixture({ days: 12 });
    const result = calibratePersonalUsage(observations, recommendations, new Date("2026-08-10T12:00:00.000Z"));

    expect(result.mode).toBe("generic-fallback");
    expect(result.calendarSpanDays).toBeLessThan(PERSONAL_USAGE_MIN_CALENDAR_DAYS);
    expect(result.reason).toBe("insufficient-calendar-span");
  });

  it("learns reliable weekday overuse and weak weekend realization only after holdout improvement", () => {
    const { observations, recommendations } = fixture();
    const result = calibratePersonalUsage(observations, recommendations, new Date("2026-08-25T12:00:00.000Z"));

    expect(result.mode).toBe("personalized");
    expect(result.reason).toBe("none");
    expect(result.validation?.personalizedMae).toBeLessThan(result.validation?.genericMae ?? 0);
    expect(result.validation?.personalizedExpiredWaste).toBeLessThan(result.validation?.genericExpiredWaste ?? 0);
    expect(result.weekdayStats[0]).toEqual(expect.objectContaining({ rememberRate: 1, overuseRate: 1 }));
    expect(result.weekdayStats[5].rememberRate).toBe(1);
    expect(result.weekdayStats[5].meanUtilization).toBeLessThan(result.weekdayStats[0].meanUtilization);
  });

  it("falls back when the recent holdout distribution drifts away from training", () => {
    const { observations, recommendations } = fixture({
      observed: (day, index) => index < 21 ? (day < 5 ? 24 : 2) : (day < 5 ? 2 : 24),
    });
    const result = calibratePersonalUsage(observations, recommendations, new Date("2026-08-25T12:00:00.000Z"));

    expect(result.mode).toBe("generic-fallback");
    expect(result.reason).toBe("distribution-drift");
  });

  it("falls back when otherwise sufficient local records are stale", () => {
    const { observations, recommendations } = fixture({ start: Date.UTC(2026, 5, 1) });
    const result = calibratePersonalUsage(observations, recommendations, new Date("2026-08-25T12:00:00.000Z"));

    expect(result.mode).toBe("generic-fallback");
    expect(result.reason).toBe("stale-history");
  });

  it("moves a non-expiry guide toward the learned weekday allocation without exceeding the cap", () => {
    const { observations, recommendations } = fixture();
    const calibration = calibratePersonalUsage(observations, recommendations, new Date("2026-08-25T12:00:00.000Z"));
    const weekdayGuide = applyPersonalUsageCalibration(baseRecommendation(0), calibration);
    const weekendGuide = applyPersonalUsageCalibration(baseRecommendation(5), calibration);

    expect(weekdayGuide.targetPercent).toBeGreaterThan(weekendGuide.targetPercent);
    expect(weekdayGuide.targetPercent).toBeLessThanOrEqual(weekdayGuide.safetyCapPercent);
    expect(weekdayGuide.policyVersion).toContain(PERSONAL_USAGE_POLICY_VERSION);
    expect(applyPersonalUsageCalibration({ ...baseRecommendation(0), targetPercent: 70 }, calibration).targetPercent).toBe(70);
  });

  it("never propagates unrelated prompt or token-shaped fields into the bounded calibration output", () => {
    const { observations, recommendations } = fixture();
    const result = calibratePersonalUsage(
      observations.map((item) => ({ ...item, prompt: "must-not-appear", token: "must-not-appear" })),
      recommendations,
      new Date("2026-08-25T12:00:00.000Z"),
    );

    expect(JSON.stringify(result)).not.toContain("must-not-appear");
    expect(Object.keys(result.weekdayStats[0])).toEqual([
      "weekday",
      "plannedDays",
      "rememberedDays",
      "rememberRate",
      "meanUsedPercent",
      "meanUtilization",
      "overuseRate",
      "meanOverusePercent",
      "allocationWeight",
    ]);
  });
});

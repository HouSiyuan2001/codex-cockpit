import { describe, expect, it } from "vitest";
import { applyResetRiskOverride, buildDailyRecommendation, estimateCarryInPercent, planCalibratedRiskQuota, recommendFatigueAwareToday, recommendToday, resetRiskPercentFromForecast, smoothKneeEfficiency, upsertDailyRecommendation, weekdayHazardsFromHistory } from "./dynamicQuota";
import type { DailyRecommendationRecord } from "../types";
import type { ResetForecast } from "../types";

const quietHazards = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1];

function forecast(overrides: Partial<ResetForecast> = {}): ResetForecast {
  return {
    score: 30,
    windowHours: 24,
    fetchedAt: "2026-08-15T16:00:00.000Z",
    resetAnnounced: false,
    resetAt: null,
    sourceUrl: "https://codex-resets.com/",
    tomorrowRiskPercent: 30,
    historySampleCount: 5,
    historyResetDates: [
      "2026-08-13",
      "2026-08-11",
      "2026-08-08",
      "2026-08-01",
      "2026-07-29",
    ],
    ...overrides,
  };
}

describe("latest P014 dynamic quota model", () => {
  it("matches the public dashboard p-squared quota example", () => {
    expect(planCalibratedRiskQuota({
      remainingPercent: 100,
      tomorrowRiskPercent: 61.79,
      fatigueKneePercent: 25,
      daysLeftInCycle: 7,
      isWeekend: true,
    })).toEqual({
      suggestedUsagePercent: 36.1,
      suggestedRemainingPercent: 63.9,
      uniformPacePercent: 12.5,
      resetRiskBoostPercent: 33.4,
      softCapPercent: 36.1,
    });
  });

  it("uses the dashboard weekday soft cap without the weekend discount", () => {
    const plan = planCalibratedRiskQuota({
      remainingPercent: 60,
      tomorrowRiskPercent: 40,
      fatigueKneePercent: 25,
      daysLeftInCycle: 4,
      isWeekend: false,
    });
    expect(plan.uniformPacePercent).toBe(12);
    expect(plan.resetRiskBoostPercent).toBe(7.7);
    expect(plan.softCapPercent).toBe(40);
    expect(plan.suggestedUsagePercent).toBe(19.7);
  });
  it("ports the smooth-knee efficiency curve", () => {
    expect(smoothKneeEfficiency(0)).toBe(1);
    expect(smoothKneeEfficiency(20)).toBeGreaterThan(0.95);
    expect(smoothKneeEfficiency(60)).toBeLessThan(1);
    expect(smoothKneeEfficiency(60)).toBeGreaterThan(0.2);
    expect(smoothKneeEfficiency(100)).toBeCloseTo(0.2, 2);
  });

  it("raises the target when immediate reset risk is higher and keeps a cap", () => {
    const low = recommendToday({
      balance: 0.6,
      cycleAge: 2,
      weekday: 2,
      nextResetHazard: 0.05,
      floor: 0.1,
      carryRelease: 1,
      riskGain: 1.5,
      weekdayHazards: quietHazards,
    });
    const high = recommendToday({
      balance: 0.6,
      cycleAge: 2,
      weekday: 2,
      nextResetHazard: 0.9,
      floor: 0.1,
      carryRelease: 1,
      riskGain: 1.5,
      weekdayHazards: quietHazards,
    });
    expect(high.target).toBeGreaterThan(low.target);
    expect(high.target).toBeLessThanOrEqual(high.safetyCap);
    expect(high.safetyCap).toBeLessThanOrEqual(0.22);
  });

  it("liquidates the remaining balance in the near-expiry state", () => {
    expect(recommendToday({
      balance: 0.37,
      cycleAge: 5,
      weekday: 3,
      nextResetHazard: 0.1,
      floor: 0.1,
      carryRelease: 1,
      riskGain: 1,
      weekdayHazards: quietHazards,
    })).toEqual({ target: 0.37, safetyCap: 0.37 });
  });

  it("uses public reset history as a risk prior while preserving the default rules", () => {
    const hazards = weekdayHazardsFromHistory(forecast());
    expect(hazards).toHaveLength(7);
    expect(hazards.every((value) => value >= 0.02 && value <= 0.95)).toBe(true);
    expect(hazards).not.toEqual(quietHazards);

    const recommendation = buildDailyRecommendation({
      weeklyWindow: { remainingPercent: 60, resetsAt: "2026-08-17T00:00:00.000Z", windowSeconds: 604800 },
      baseline: {
        provider: "codex",
        period: "weekly",
        localDate: "2026-08-13",
        capturedAt: "2026-08-13T08:00:00.000Z",
        remainingPercent: 60,
        resetsAt: "2026-08-17T00:00:00.000Z",
        cycleStartedAt: "2026-08-11T04:00:00.000Z",
        cycleStartRemainingPercent: 100,
        planningResetsAt: "2026-08-17T00:00:00.000Z",
        resetForecastScore: 30,
        resetForecastWindowHours: 24,
      },
      resetForecast: forecast(),
      now: new Date("2026-08-13T12:00:00.000+08:00"),
    });
    expect(recommendation?.source).toBe("remote-history");
    expect(recommendation?.targetPercent).toBeGreaterThan(0);
    expect(recommendation?.targetPercent).toBeLessThanOrEqual(recommendation?.safetyCapPercent ?? 0);
  });

  it("applies a direct 0-100% local risk override before recomputing the daily guide", () => {
    const base = forecast({ score: 18, tomorrowRiskPercent: 18 });
    expect(resetRiskPercentFromForecast(base)).toBe(18);
    expect(applyResetRiskOverride(base, 25)?.tomorrowRiskPercent).toBe(25);
    expect(applyResetRiskOverride(base, 99)?.score).toBe(99);
    expect(applyResetRiskOverride(base, -99)?.score).toBe(0);
    expect(applyResetRiskOverride(base, null)).toEqual(base);

    const weeklyWindow = { remainingPercent: 60, resetsAt: "2026-08-17T00:00:00.000Z", windowSeconds: 604800 };
    const now = new Date("2026-08-14T12:00:00Z");
    const ordinary = buildDailyRecommendation({ weeklyWindow, resetForecast: base, now });
    const cautious = buildDailyRecommendation({
      weeklyWindow,
      resetForecast: base,
      resetRiskOverridePercent: 25,
      now,
    });
    expect(cautious?.resetRiskPercent).toBe(25);
    expect(cautious?.targetPercent).toBeGreaterThanOrEqual(ordinary?.targetPercent ?? 0);
  });

  it("uses the T009 risk, carry, and fatigue-knee dimensions together", () => {
    const lowRisk = recommendFatigueAwareToday({ balance: 1, cycleAge: 0, nextResetHazard: 0.1, fatigueKneePercent: 25, futureDays: 5 });
    const highRisk = recommendFatigueAwareToday({ balance: 1, cycleAge: 0, nextResetHazard: 0.7, fatigueKneePercent: 25, futureDays: 5 });
    const carried = recommendFatigueAwareToday({ balance: 1, cycleAge: 0, nextResetHazard: 0.1, fatigueKneePercent: 25, carryIn: 0.1, futureDays: 5 });
    const durable = recommendFatigueAwareToday({ balance: 1, cycleAge: 0, nextResetHazard: 0.1, fatigueKneePercent: 100, futureDays: 5 });

    expect(highRisk.target).toBeGreaterThan(lowRisk.target);
    expect(carried.target).toBeGreaterThan(lowRisk.target);
    expect(durable.target).toBeGreaterThanOrEqual(lowRisk.target);
    expect(lowRisk.target).toBeLessThanOrEqual(lowRisk.safetyCap);
  });

  it("persists and reuses yesterday's missed recommendation as carry", () => {
    const previous: DailyRecommendationRecord = {
      provider: "codex",
      localDate: "2026-08-15",
      targetPercent: 32,
      safetyCapPercent: 80,
      resetRiskPercent: 20,
      fatigueKneePercent: 25,
      carryInPercent: 0,
      policyVersion: "p014-t009-fatigue-carry-dp-v1",
      updatedAt: "2026-08-15T12:00:00.000Z",
    };
    const now = new Date("2026-08-16T12:00:00.000Z");
    const records = [previous];
    expect(estimateCarryInPercent(records, [{ localDate: "2026-08-15", observedUsedPercent: 5, sampleCount: 3 }], now)).toBe(27);
    expect(upsertDailyRecommendation(records, { ...previous, updatedAt: "2026-08-16T12:00:00.000Z" })).toBe(records);
  });
});

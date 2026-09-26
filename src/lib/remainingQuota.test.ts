import { expect, it } from "vitest";
import { buildDailyRecommendation, planRemainingQuota, quotaConsumptionUrgency } from "./dynamicQuota";
const base = { remainingPercent: 80, daysUntilReset: 4, tomorrowRiskPercent: 0, fatigueKneePercent: 100, isWeekend: false };
it("defines urgency from balance and exact days without capping rates above 100", () => {
  expect(quotaConsumptionUrgency(80, 4)).toBe(20);
  expect(quotaConsumptionUrgency(80, 2)).toBe(40);
  expect(quotaConsumptionUrgency(40, 4)).toBe(10);
  expect(quotaConsumptionUrgency(80, 0.1)).toBe(800);
  expect(quotaConsumptionUrgency(0, 4)).toBe(0);
  expect(quotaConsumptionUrgency(80, 0)).toBeNull();
  expect(quotaConsumptionUrgency(80, -1)).toBeNull();
  expect(quotaConsumptionUrgency(80, NaN)).toBeNull();
});
it("divides by exact days, without adding an extra day or rounding the horizon", () => {
  expect(planRemainingQuota(base).suggestedUsagePercent).toBe(20);
  expect(planRemainingQuota({ ...base, daysUntilReset: 2.5 }).suggestedUsagePercent).toBe(32);
  expect(planRemainingQuota({ ...base, todayFractionRemaining: 0.5 }).suggestedUsagePercent).toBe(10);
});
it("is bounded and increases with balance, proximity to reset, and risk", () => {
  for (const daysUntilReset of [0.01, 0.5, 1, 2.5, 4, 7]) {
    let previous = 0;
    for (let remainingPercent = 0; remainingPercent <= 100; remainingPercent += 5) {
      const value = planRemainingQuota({ ...base, daysUntilReset, remainingPercent }).suggestedUsagePercent;
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(remainingPercent);
      previous = value;
    }
  }
  expect(planRemainingQuota({ ...base, daysUntilReset: 2 }).suggestedUsagePercent).toBeGreaterThan(planRemainingQuota(base).suggestedUsagePercent);
  expect(planRemainingQuota({ ...base, tomorrowRiskPercent: 50 }).suggestedUsagePercent).toBeGreaterThan(planRemainingQuota(base).suggestedUsagePercent);
  expect(planRemainingQuota({ ...base, daysUntilReset: 0 }).suggestedUsagePercent).toBe(0);
});
it("counts today's consumption once and obeys the remaining fatigue allowance", () => {
  expect(planRemainingQuota({ ...base, fatigueKneePercent: 30, todayUsedPercent: 25 }).suggestedUsagePercent).toBe(5);
  expect(planRemainingQuota({ ...base, fatigueKneePercent: 30, todayUsedPercent: 35 }).suggestedUsagePercent).toBe(0);
  const args = { weeklyWindow: { remainingPercent: 80, resetsAt: "2026-09-11T20:00:00Z", windowSeconds: 604800 }, now: new Date("2026-09-09T08:00:00Z"), todayUsedPercent: 5 };
  const result = buildDailyRecommendation(args)!;
  expect(result.futureDays).toBe(2.5);
  expect(result.targetPercent).toBeCloseTo(5 + result.additionalUsagePercent!, 1);
  expect(buildDailyRecommendation({ ...args, carryInPercent: 30 })).toEqual(result);
  expect(buildDailyRecommendation({ ...args, weeklyWindow: { ...args.weeklyWindow, resetsAt: null } })).toBeNull();
  expect(buildDailyRecommendation({ ...args, now: new Date("2026-09-12T00:00:00Z") })).toBeNull();
});

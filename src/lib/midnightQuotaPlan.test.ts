import { describe, expect, it } from "vitest";
import { beijingMidnight, buildMidnightQuotaPlan } from "./midnightQuotaPlan";
import { buildTodayQuotaAdvice } from "./todayQuota";
import { quotaHeatmapUsage } from "../components/ResetRiskQuotaHeatmap";
import type { ProviderSnapshot, QuotaHistoryPoint } from "../types";

const reset = "2026-09-16T12:23:20Z";
const point = (at: string, metric: number, resetsAt = reset): QuotaHistoryPoint => ({ provider: "codex", capturedAt: at, metric, metricKind: "percent", status: "ok", resetsAt });
const snapshot = (at: string, remaining: number, resetsAt = reset): ProviderSnapshot => ({ provider: "codex", displayName: "Codex", plan: "Pro", shortWindow: null, weeklyWindow: { windowSeconds: 604800, remainingPercent: remaining, resetsAt }, resetCredits: null, updatedAt: at, status: "ok", message: null });
const history = [point("2026-09-10T15:49:00Z", 43), point("2026-09-10T16:19:00Z", 43)];
function plan(at: string, remaining: number, riskPercent = 86, records = history, resetsAt = reset) {
  return buildMidnightQuotaPlan({ history: records, snapshot: snapshot(at, remaining, resetsAt), riskPercent, forecast: null, fatigueKneePercent: 25, now: new Date(at) })!;
}

describe("Beijing midnight quota plan", () => {
  it("freezes balance, time horizon and day total while usage changes", () => {
    const morning = plan("2026-09-11T01:00:00Z", 39);
    const evening = plan("2026-09-11T13:00:00Z", 23);
    expect(morning.dayPlan).toEqual(evening.dayPlan);
    expect(evening.dayPlan).toMatchObject({ localDate: "2026-09-11", remainingPercent: 43, anchorAt: "2026-09-10T16:00:00.000Z", kind: "near-midnight" });
    expect(evening.targetPercent).toBe(morning.targetPercent);
    expect(evening.futureDays).toBe(morning.futureDays);
    expect(evening.todayFractionRemaining).toBe(1);
    expect(evening.todayUsedPercent).toBe(20);
    expect(evening.additionalUsagePercent).toBeCloseTo(evening.targetPercent - 20);
    expect(evening.targetPercent).toBe(quotaHeatmapUsage({ remainingPercent: evening.dayPlan!.remainingPercent, daysUntilReset: evening.futureDays, tomorrowRiskPercent: evening.resetRiskPercent, fatigueKneePercent: 25, isWeekend: false, todayUsedPercent: 0, todayFractionRemaining: 1 }));
    expect(plan("2026-09-11T13:00:00Z", 23, 10).targetPercent).toBeLessThan(evening.targetPercent);
  });
  it("rolls over at 00:00 Beijing, not the legacy 04:00 ledger boundary", () => {
    expect(beijingMidnight(new Date("2026-09-11T15:59:59Z"))).toBe(Date.parse("2026-09-10T16:00:00Z"));
    expect(beijingMidnight(new Date("2026-09-11T16:00:00Z"))).toBe(Date.parse("2026-09-11T16:00:00Z"));
    const next = plan("2026-09-11T17:00:00Z", 20, 86, [...history, point("2026-09-11T15:59:00Z", 23)]);
    expect(next.dayPlan?.localDate).toBe("2026-09-12");
    expect(next.dayPlan?.remainingPercent).toBe(23);
    const advice = buildTodayQuotaAdvice({ status: "ok", dynamicRecommendation: next, now: new Date("2026-09-11T17:00:00Z") });
    expect(advice.todayUsedPercent).toBe(3);
    expect(advice.todaySuggestedPercent).toBe(next.targetPercent);
  });
  it("labels a missing midnight snapshot and freezes the first observation", () => {
    const first = point("2026-09-11T02:00:00Z", 40);
    const later = plan("2026-09-11T09:00:00Z", 25, 86, [first]);
    expect(later.dayPlan).toMatchObject({ remainingPercent: 40, kind: "first-observation", anchorAt: new Date(first.capturedAt).toISOString() });
    expect(later.todayUsedPercent).toBe(15);
    expect(later.targetPercent).toBe(plan(first.capturedAt, 40, 86, [first]).targetPercent);
  });
  it("does not reuse a previous cycle baseline after an intraday reset", () => {
    const newReset = "2026-09-18T03:00:00Z";
    const records = [...history, point("2026-09-11T02:00:00Z", 30), point("2026-09-11T03:01:00Z", 100, newReset)];
    const next = plan("2026-09-11T05:00:00Z", 96, 86, records, newReset);
    expect(next.dayPlan).toMatchObject({ remainingPercent: 100, kind: "first-observation" });
    expect(next.todayUsedPercent).toBe(4);
  });
  it("rejects stale snapshots instead of creating a new baseline", () => {
    const input = { snapshot: { ...snapshot("2026-09-11T05:00:00Z", 30), status: "stale" as const }, riskPercent: 86, forecast: null, fatigueKneePercent: 25, now: new Date("2026-09-11T05:00:00Z") };
    expect(buildMidnightQuotaPlan({ ...input, history: [] })).toBeNull();
    const saved = buildMidnightQuotaPlan({ ...input, history })!;
    expect(saved.dayPlan?.remainingPercent).toBe(43);
    expect(saved.todayUsedPercent).toBe(0);
    expect(buildTodayQuotaAdvice({ status: "stale", dynamicRecommendation: saved, now: input.now }).todaySuggestedPercent).toBe(saved.targetPercent);
  });
});

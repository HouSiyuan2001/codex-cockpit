import { describe, expect, it } from "vitest";
import { comfortFeedbackScore, comfortFeedbackWeight, COMFORT_CURVE_VERSION, normalizeComfortFeedbackRecord, personalizeComfortCurve, selectComfortUsage, smoothKneeEfficiency } from "./comfortFeedback";
import type { ComfortFeedbackRecord } from "../types";
const now = new Date(2026, 8, 11, 12);
const record = (comfort: ComfortFeedbackRecord["comfort"], used: number): ComfortFeedbackRecord => ({
  localDate: "2026-09-10", observedAt: now.toISOString(), comfort, observedUsedPercent: used,
  usageCoverage: "complete", usageObservedAt: now.toISOString(), usageSource: "official-snapshot", curveVersion: COMFORT_CURVE_VERSION,
});

describe("fixed user scores and cumulative daily usage", () => {
  it("uses exactly the user's scores", () => {
    expect([comfortFeedbackScore("idle"), comfortFeedbackScore("comfortable"), comfortFeedbackScore("overloaded")]).toEqual([1, 0.8, 0.25]);
  });
  it("minimizes weighted score residuals by changing only k", () => {
    const records = [record("idle", 10), record("comfortable", 40), { ...record("overloaded", 65), usageCoverage: "partial" as const }];
    const before = JSON.stringify(records);
    const fitted = personalizeComfortCurve(records, now);
    const loss = (k: number) => records.reduce((sum, item) => sum + comfortFeedbackWeight(item, now) * (smoothKneeEfficiency(item.observedUsedPercent!, k) - comfortFeedbackScore(item.comfort)) ** 2, 0);
    for (let index = 1; index <= 1000; index++) expect(loss(fitted.xStarPercent)).toBeLessThanOrEqual(loss(index / 10) + 1e-9);
    expect(loss(fitted.xStarPercent)).toBeLessThan(loss(25));
    expect(JSON.stringify(records)).toBe(before);
  });
  it("retains >100 through normalization, allocation and observation construction", () => {
    const source = { ...record("overloaded", 200), quotaAllocation: {
      metricVersion: "cost-share-v1" as const, localDate: "2026-09-10", observedAt: now.toISOString(), totalUsedPercent: 200,
      personCostUsd: 75, totalCostUsd: 100, costShare: 0.75, allocatedUsedPercent: 150,
      coverage: "complete" as const, deviceIds: ["mac"], missingDeviceIds: [],
    } };
    const clean = normalizeComfortFeedbackRecord(source)!;
    expect(clean.observedUsedPercent).toBe(200);
    expect(clean.quotaAllocation?.allocatedUsedPercent).toBe(150);
    expect(normalizeComfortFeedbackRecord(clean)).toEqual(clean);
    expect(personalizeComfortCurve([clean], now).observations[0].usedPercent).toBe(200);
    expect(selectComfortUsage("2026-09-10", null, [{ provider: "codex", localDate: "2026-09-10", sampleCount: 2, observedUsedPercent: 175, updatedAt: now.toISOString() }]).observedUsedPercent).toBe(175);
    for (const invalid of [-1, NaN, Infinity, 10001]) expect(normalizeComfortFeedbackRecord(record("idle", invalid))).toBeNull();
  });
  it("keeps the original family and its floor when extending beyond 100", () => {
    for (const k of [0.1, 25, 50, 80, 100]) {
      expect(smoothKneeEfficiency(0, k)).toBeCloseTo(1);
      expect(smoothKneeEfficiency(100, k)).toBeCloseTo(0.2);
      expect(smoothKneeEfficiency(200, k)).toBeCloseTo(0.2);
    }
    expect(personalizeComfortCurve([record("overloaded", 175)], now).xStarPercent).toBe(25);
  });
});

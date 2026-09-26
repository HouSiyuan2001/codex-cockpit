import { describe, expect, it } from "vitest";
import { mergeSyncedComfortFeedback } from "./comfortSync";
import { COMFORT_CURVE_VERSION, normalizeComfortFeedbackRecords } from "./comfortFeedback";
import type { ComfortFeedbackRecord } from "../types";

const now = new Date("2026-09-11T08:00:00Z");
const record = (overrides: Partial<ComfortFeedbackRecord> = {}): ComfortFeedbackRecord => ({
  localDate: "2026-09-10", observedAt: "2026-09-10T08:00:00Z", personId: "alex", comfort: "comfortable",
  observedUsedPercent: 42, usageObservedAt: "2026-09-10T08:00:00Z", usageCoverage: "partial", usageSource: "official-snapshot", curveVersion: COMFORT_CURVE_VERSION, ...overrides,
});

describe("comfort sync merge", () => {
  it("unions people without replacing local legacy or accepting remote legacy", () => {
    const local = record({ personId: null });
    const merged = mergeSyncedComfortFeedback([local, record()], [record({ personId: "blair" }), record({ personId: null, comfort: "idle" })], now)!;
    expect(merged).toHaveLength(3);
    expect(merged.find(r => r.personId === null)?.comfort).toBe("comfortable");
  });
  it("preserves a later edit and uses refresh revision rather than observation time", () => {
    const fresh = record({ updatedAt: "2026-09-11T07:00:00Z", observedUsedPercent: 46 });
    expect(mergeSyncedComfortFeedback([fresh], [record()], now)).toBeNull();
    const merged = mergeSyncedComfortFeedback([record()], [fresh], now)!;
    expect(merged[0].observedUsedPercent).toBe(46);
    expect(merged[0].observedAt).toBe(record().observedAt);
    expect(normalizeComfortFeedbackRecords(JSON.parse(JSON.stringify(merged)))[0].updatedAt).toBe(fresh.updatedAt);
    expect(mergeSyncedComfortFeedback(merged, [fresh], now)).toBeNull();
  });
  it("resolves equal timestamp conflicts deterministically on both devices", () => {
    const a = record(), b = record({ comfort: "idle" });
    const left = mergeSyncedComfortFeedback([a], [b], now) ?? [a];
    const right = mergeSyncedComfortFeedback([b], [a], now) ?? [b];
    expect(normalizeComfortFeedbackRecords(left)).toEqual(normalizeComfortFeedbackRecords(right));
  });
  it("ignores malformed and future-dated revisions without clearing local data", () => {
    expect(mergeSyncedComfortFeedback([record()], [null, {}, record({ updatedAt: "2099-01-01T00:00:00Z", comfort: "idle" }), record({ localDate: "2099-01-01" }), record({ observedAt: "2099-01-01T00:00:00Z", updatedAt: "2026-09-10T08:00:00Z" })], now)).toBeNull();
    expect(mergeSyncedComfortFeedback([record()], null, now)).toBeNull();
  });
  it("allows valid feedback to recover a same-date local record with a poisoned clock", () => {
    const poisoned = record({ updatedAt: "2099-01-01T00:00:00Z", comfort: "idle" });
    expect(mergeSyncedComfortFeedback([poisoned], [record()], now)?.[0].comfort).toBe("comfortable");
  });
  it("does not alter stored percentage allocation and strips unknown fields", () => {
    const r = record({ quotaAllocation: { metricVersion: "cost-share-v1", localDate: "2026-09-10", observedAt: "2026-09-10T08:00:00Z", totalUsedPercent: 42, personCostUsd: 30, totalCostUsd: 100, costShare: .3, allocatedUsedPercent: 12.6, coverage: "partial", deviceIds: ["mac"], missingDeviceIds: [] } });
    const merged = mergeSyncedComfortFeedback([], [{ ...r, message: "private" }], now)!;
    expect(merged[0].observedUsedPercent).toBe(42);
    expect(merged[0].quotaAllocation?.allocatedUsedPercent).toBeCloseTo(12.6);
    expect(JSON.stringify(merged)).not.toContain("private");
  });
});

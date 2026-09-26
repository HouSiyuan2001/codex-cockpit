import { describe, expect, it } from "vitest";
import type { ComfortQuotaAllocation } from "../types";
import type { DailyModelUsage, TokeiDevice, TokeiUsage } from "./tokeiUsage";
import { buildPersonQuotaAllocation, PERSON_QUOTA_ALLOCATION_VERSION } from "./personQuotaAllocation";

const targetDate = "2026-09-09";
const now = new Date(2026, 8, 10, 12);

function day(cost: number | null): DailyModelUsage {
  return {
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 1,
    estimatedCostUsd: cost,
    models: [],
  };
}

function device(id: string, cost: number | null, overrides: Partial<TokeiDevice> = {}): TokeiDevice {
  return {
    id,
    updatedAt: now.toISOString(),
    stale: false,
    daily: { [targetDate]: day(cost) },
    ranges: {},
    ...overrides,
  };
}

function usage(devices: TokeiDevice[]): TokeiUsage {
  return {
    fetchedAt: now.toISOString(),
    status: "ready",
    groups: [
      { id: "alex", name: "成员甲", deviceIds: ["Mac"] },
      { id: "blair", name: "成员乙", deviceIds: ["PC"] },
    ],
    defaultGroupId: "alex",
    devices,
    warnings: [],
    projectBreakdownAvailable: true,
  };
}

const total = {
  observedUsedPercent: 60,
  usageCoverage: "complete" as const,
  usageObservedAt: now.toISOString(),
};

describe("person quota allocation", () => {
  it("allocates cumulative daily use beyond one full quota without capping it", () => {
    const allocation = buildPersonQuotaAllocation(usage([device("Mac", 70), device("PC", 30)]), "alex", targetDate, { ...total, observedUsedPercent: 200 }, now)!;
    expect(allocation.totalUsedPercent).toBe(200);
    expect(allocation.allocatedUsedPercent).toBe(140);
    expect(allocation.costShare).toBe(0.7);
  });
  it("allocates shared quota percent by exact daily estimated-cost share", () => {
    const allocation = buildPersonQuotaAllocation(usage([
      device("Mac", 30),
      device("PC", 70),
    ]), "alex", targetDate, total, now);

    expect(allocation).toEqual({
      metricVersion: PERSON_QUOTA_ALLOCATION_VERSION,
      localDate: targetDate,
      observedAt: now.toISOString(),
      totalUsedPercent: 60,
      personCostUsd: 30,
      totalCostUsd: 100,
      costShare: 0.3,
      allocatedUsedPercent: 18,
      coverage: "complete",
      deviceIds: ["Mac", "PC"],
      missingDeviceIds: [],
    });
  });

  it("includes readable unassigned devices so people's estimates do not consume their cost share", () => {
    const data = usage([device("Mac", 30), device("PC", 60), device("Shared-Agent", 10)]);
    const alex = buildPersonQuotaAllocation(data, "alex", targetDate, total, now)!;
    const blair = buildPersonQuotaAllocation(data, "blair", targetDate, total, now)!;
    expect(alex.allocatedUsedPercent).toBe(18);
    expect(blair.allocatedUsedPercent).toBe(36);
    expect(alex.allocatedUsedPercent! + blair.allocatedUsedPercent!).toBeLessThanOrEqual(60);
    expect(alex.totalCostUsd).toBe(100);
  });

  it("deduplicates device ids across groups and duplicate snapshots", () => {
    const data = usage([
      device("Mac", 999, { updatedAt: new Date(now.getTime() - 60_000).toISOString() }),
      device("Mac", 30),
      device("PC", 70),
    ]);
    data.groups[1].deviceIds.push("Mac");
    const allocation = buildPersonQuotaAllocation(data, "alex", targetDate, total, now)!;
    expect(allocation.totalCostUsd).toBe(100);
    expect(allocation.personCostUsd).toBe(30);
    expect(allocation.deviceIds).toEqual(["Mac", "PC"]);
  });

  it("uses known positive costs only as a partial estimate and never assumes a missing numerator is zero", () => {
    const data = usage([device("Mac", 30), device("PC", null)]);
    const alex = buildPersonQuotaAllocation(data, "alex", targetDate, total, now)!;
    expect(alex).toEqual(expect.objectContaining({
      coverage: "partial",
      personCostUsd: 30,
      totalCostUsd: 30,
      costShare: 1,
      allocatedUsedPercent: 60,
      missingDeviceIds: ["PC"],
    }));
    const blair = buildPersonQuotaAllocation(data, "blair", targetDate, total, now)!;
    expect(blair).toEqual(expect.objectContaining({ coverage: "partial", personCostUsd: null, costShare: null, allocatedUsedPercent: null }));
  });

  it("keeps a zero or missing denominator strictly unavailable, including shared zero percent", () => {
    const zero = buildPersonQuotaAllocation(usage([device("Mac", 0), device("PC", 0)]), "alex", targetDate, total, now)!;
    expect(zero).toEqual(expect.objectContaining({ coverage: "unavailable", totalCostUsd: null, allocatedUsedPercent: null }));
    const sharedZero = buildPersonQuotaAllocation(
      usage([device("Mac", 0), device("PC", null)]),
      "alex",
      targetDate,
      { ...total, observedUsedPercent: 0 },
      now,
    )!;
    expect(sharedZero).toEqual(expect.objectContaining({ totalUsedPercent: 0, coverage: "unavailable", allocatedUsedPercent: null }));
  });

  it("rejects unknown groups and quarantines future dates or quota timestamps", () => {
    const data = usage([device("Mac", 30), device("PC", 70)]);
    expect(buildPersonQuotaAllocation(data, "unknown", targetDate, total, now)).toBeNull();
    expect(buildPersonQuotaAllocation(data, "alex", "2026-09-11", total, now)).toEqual(expect.objectContaining({ coverage: "unavailable", allocatedUsedPercent: null }));
    expect(buildPersonQuotaAllocation(data, "alex", targetDate, { ...total, usageObservedAt: "2027-01-01T00:00:00Z" }, now)).toEqual(expect.objectContaining({ coverage: "unavailable" }));
  });

  it("marks a not-yet-closed calendar day partial even with complete shared quota coverage", () => {
    const currentDate = "2026-09-10";
    const data = usage([
      device("Mac", 30, { daily: { [currentDate]: day(30) } }),
      device("PC", 70, { daily: { [currentDate]: day(70) } }),
    ]);
    expect(buildPersonQuotaAllocation(data, "alex", currentDate, total, now)).toEqual(expect.objectContaining({
      coverage: "partial",
      allocatedUsedPercent: 18,
    }));
  });

  it("falls back from a future fetchedAt timestamp and marks the estimate partial", () => {
    const data = usage([device("Mac", 30), device("PC", 70)]);
    data.fetchedAt = new Date(now.getTime() + 3_600_000).toISOString();
    const allocation = buildPersonQuotaAllocation(data, "alex", targetDate, total, now)!;
    expect(allocation.observedAt).toBe(now.toISOString());
    expect(allocation).toEqual(expect.objectContaining({ coverage: "partial", allocatedUsedPercent: 18 }));
  });
});

export const allocationFixture: ComfortQuotaAllocation = {
  metricVersion: "cost-share-v1",
  localDate: targetDate,
  observedAt: now.toISOString(),
  totalUsedPercent: 60,
  personCostUsd: 30,
  totalCostUsd: 100,
  costShare: 0.3,
  allocatedUsedPercent: 18,
  coverage: "complete",
  deviceIds: ["Mac", "PC"],
  missingDeviceIds: [],
};

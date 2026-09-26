import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendComfortFeedback, appendComfortPromptedDate, buildComfortPrompt, comfortReminderKey, comfortYield, COMFORT_CURVE_VERSION, createComfortFeedbackRecord, getComfortPromptTarget, getPersonComfortPromptTarget, normalizeComfortFeedbackRecord, normalizeComfortFeedbackRecords, normalizeComfortPromptedKeys, normalizeComfortQuotaAllocation, personalizeComfortCurve, selectComfortUsage, smoothKneeEfficiency, upsertComfortFeedbackRecord } from "./comfortFeedback";
import type { ComfortFeedbackRecord } from "../types";

const localDate = (year: number, month: number, day: number, hour: number, minute = 0) => new Date(year, month - 1, day, hour, minute);
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(localDate(2026, 8, 14, 12)); });
afterEach(() => vi.useRealTimers());

function record(overrides: Partial<ComfortFeedbackRecord> = {}): ComfortFeedbackRecord {
  return {
    localDate: "2026-08-12",
    observedAt: "2026-08-12T14:00:00.000Z",
    comfort: "comfortable",
    observedUsedPercent: 18,
    usageObservedAt: "2026-08-12T16:00:00.000Z",
    usageCoverage: "complete",
    usageSource: "official-snapshot",
    curveVersion: COMFORT_CURVE_VERSION,
    ...overrides,
  };
}

describe("comfort feedback scheduling", () => {
  it("opens only after 22:00 for the current local date", () => {
    const before = getComfortPromptTarget(localDate(2026, 8, 13, 21), []);
    expect(before).toEqual({ localDate: "2026-08-12", isCatchUp: true });

    const after = getComfortPromptTarget(localDate(2026, 8, 13, 22), [record({ localDate: "2026-08-12" })]);
    expect(after).toEqual({ localDate: "2026-08-13", isCatchUp: false });
  });

  it("does not prompt a date twice after a local record exists", () => {
    expect(getComfortPromptTarget(localDate(2026, 8, 13, 23), [record({ localDate: "2026-08-13" })])).toBeNull();
    expect(getComfortPromptTarget(localDate(2026, 8, 13, 23), [], ["2026-08-13"])).toBeNull();
    expect(appendComfortPromptedDate([], "2026-08-13")).toEqual(["legacy:2026-08-13"]);
  });

  it("isolates assigned reminder and feedback identities from legacy dates", () => {
    const dates = appendComfortPromptedDate(["2026-08-13"], "2026-08-13", "group:alex");
    expect(dates).toEqual(["legacy:2026-08-13", "person:group%3Aalex:2026-08-13"]);
    expect(comfortReminderKey("group:alex", "2026-08-13")).toBe("person:group%3Aalex:2026-08-13");
    expect(getPersonComfortPromptTarget("group:alex", localDate(2026, 8, 13, 23), [], dates)).toBeNull();
    expect(getPersonComfortPromptTarget("group:blair", localDate(2026, 8, 13, 23), [], dates)).toEqual({ localDate: "2026-08-13", isCatchUp: false });
    expect(getComfortPromptTarget(localDate(2026, 8, 13, 23), [], dates)).toBeNull();
    expect(normalizeComfortPromptedKeys(["bad", ...dates, dates[1]])).toEqual(dates);
  });
});

describe("comfort feedback usage and curve", () => {
  it("prefers the official snapshot and falls back to local history for catch-up", () => {
    const official = {
      localDate: "2026-08-13",
      observedUsedPercent: 6,
      usageObservedAt: "2026-08-13T16:00:00.000Z",
      sampleCount: 4,
      firstObservedAt: null,
      lastObservedAt: "2026-08-13T16:00:00.000Z",
      coverage: "partial" as const,
      source: "codex-session-rate-limits" as const,
    };
    expect(selectComfortUsage("2026-08-13", official, [])).toEqual({
      observedUsedPercent: 6,
      usageObservedAt: "2026-08-13T16:00:00.000Z",
      usageCoverage: "partial",
      usageSource: "official-snapshot",
    });
    expect(selectComfortUsage("2026-08-12", null, [{ provider: "codex", localDate: "2026-08-12", observedUsedPercent: 13, sampleCount: 2, updatedAt: "2026-08-12T16:00:00.000Z" }])).toEqual({
      observedUsedPercent: 13,
      usageObservedAt: "2026-08-12T16:00:00.000Z",
      usageCoverage: "partial",
      usageSource: "local-history",
    });
  });

  it("keeps the reference peak at 25% and uses a conservative fallback", () => {
    expect(comfortYield(25)).toBeCloseTo(1, 8);
    expect(comfortYield(100)).toBeCloseTo(0.199, 3);
    const baseline = personalizeComfortCurve([]);
    expect(baseline).toEqual(expect.objectContaining({ xStarPercent: 25, baselineXStarPercent: 25, sampleCount: 0, confidence: 0, mode: "baseline-fallback" }));
    expect(baseline.points).toHaveLength(101);
    expect(baseline.points[0]).toEqual({ usedPercent: 0, baselineScore: 1, personalizedScore: 1 });
    expect(baseline.points.at(-1)).toEqual({ usedPercent: 100, baselineScore: 0.2, personalizedScore: 0.2 });
    expect(baseline.observations).toEqual([]);
  });

  it("starts at peak unit efficiency and follows the reference knee shapes", () => {
    const checkpoints = [0, 25, 50, 75, 100];
    const expected = new Map<number, number[]>([
      [25, [1, 0.994, 0.646, 0.334, 0.2]],
      [50, [1, 1, 0.993, 0.574, 0.2]],
      [80, [1, 1, 1, 0.999, 0.2]],
      [100, [1, 1, 1, 1, 0.2]],
    ]);

    for (const [knee, values] of expected) {
      checkpoints.forEach((usedPercent, index) => {
        expect(smoothKneeEfficiency(usedPercent, knee)).toBeCloseTo(values[index], 3);
      });
    }
  });

  it("fits the local curve from actual observed usage and preserves the sample points", () => {
    const prompt = buildComfortPrompt({ localDate: "2026-08-13", isCatchUp: false }, {
      localDate: "2026-08-13",
      observedUsedPercent: 30,
      sampleCount: 1,
      firstObservedAt: null,
      lastObservedAt: null,
      coverage: "complete",
      source: "codex-session-rate-limits",
    });
    const next = createComfortFeedbackRecord(prompt, "overloaded", new Date("2026-08-13T14:00:00.000Z"));
    const curve = personalizeComfortCurve([next]);
    expect(next).toEqual(expect.objectContaining({ localDate: "2026-08-13", observedUsedPercent: 30, comfort: "overloaded", curveVersion: COMFORT_CURVE_VERSION }));
    expect(curve.mode).toBe("personalized");
    expect(curve.baselineXStarPercent).toBe(25);
    expect(curve.xStarPercent).not.toBe(25);
    expect(curve.observations).toEqual([expect.objectContaining({ localDate: "2026-08-13", usedPercent: 30, comfort: "overloaded", usageCoverage: "complete" })]);
    expect(appendComfortFeedback([next], { ...next, comfort: "comfortable" })).toHaveLength(1);
  });

  it("migrates the previous curve record version without discarding its real observation", () => {
    const migrated = normalizeComfortFeedbackRecord(record({ curveVersion: "p014-t014-smooth-knee-v2", observedUsedPercent: 42 }));
    expect(migrated).toEqual(expect.objectContaining({
      curveVersion: COMFORT_CURVE_VERSION,
      observedUsedPercent: 42,
      comfort: "comfortable",
    }));
  });

  it("moves the fitted knee in the direction of the user's real feedback", () => {
    const lowerUseComfortable = personalizeComfortCurve([
      record({ localDate: "2026-08-10", observedUsedPercent: 18, comfort: "comfortable" }),
      record({ localDate: "2026-08-11", observedUsedPercent: 24, comfort: "comfortable" }),
      record({ localDate: "2026-08-12", observedUsedPercent: 30, comfort: "overloaded" }),
    ]);
    const higherUseComfortable = personalizeComfortCurve([
      record({ localDate: "2026-08-10", observedUsedPercent: 35, comfort: "comfortable" }),
      record({ localDate: "2026-08-11", observedUsedPercent: 44, comfort: "comfortable" }),
      record({ localDate: "2026-08-12", observedUsedPercent: 55, comfort: "overloaded" }),
    ]);
    expect(higherUseComfortable.xStarPercent).toBeGreaterThan(lowerUseComfortable.xStarPercent);
    expect(higherUseComfortable.sampleCount).toBe(3);
  });

  it("edits a calendar entry without discarding its observed usage snapshot", () => {
    const existing = record({ localDate: "2026-08-12", comfort: "comfortable", observedUsedPercent: 31 });
    const next = upsertComfortFeedbackRecord([existing], "2026-08-12", "overloaded", new Date("2026-08-14T12:00:00.000Z"));

    expect(next).toEqual([expect.objectContaining({
      localDate: "2026-08-12",
      comfort: "overloaded",
      observedUsedPercent: 31,
      usageCoverage: "complete",
      usageSource: "official-snapshot",
      observedAt: "2026-08-14T12:00:00.000Z",
    })]);
  });

  it("upserts by person and date without assigning legacy records", () => {
    const legacy = record({ localDate: "2026-08-12" });
    const alex = record({ localDate: "2026-08-12", personId: "alex", personName: "成员甲" });
    const blair = record({ localDate: "2026-08-12", personId: "blair", personName: "成员乙" });
    const edited = upsertComfortFeedbackRecord([legacy, alex, blair], "2026-08-12", "overloaded", new Date("2026-08-14T12:00:00.000Z"), "alex");

    expect(edited).toHaveLength(3);
    expect(edited.find(item => item.personId === "alex")?.comfort).toBe("overloaded");
    expect(edited.find(item => item.personId === "blair")?.comfort).toBe("comfortable");
    expect(edited.find(item => item.personId === null)?.comfort).toBe("comfortable");
  });

  it("roundtrips bounded optional person and token snapshot fields", () => {
    const normalized = normalizeComfortFeedbackRecord(record({
      personId: "stable-group-id",
      personName: " 成员甲 ",
      tokenSnapshot: {
        localDate: "2026-08-12",
        observedAt: "2026-08-13T02:00:00.000Z",
        metricVersion: "calendar-token-v1",
        coverage: "partial",
        inputTokens: 1_000_000,
        cachedInputTokens: 2_000_000,
        outputTokens: 500_000,
        reasoningTokens: 100_000,
        totalTokens: 999,
        models: [{ id: "m", name: "Model", inputTokens: 1_000_000, cachedInputTokens: 2_000_000, outputTokens: 500_000, reasoningTokens: 100_000, totalTokens: 1 }],
        deviceIds: ["Mac", "Mac"],
        missingDeviceIds: ["PC"],
        incompleteDeviceIds: ["Mac"],
      },
    }));

    expect(normalized).toEqual(expect.objectContaining({ personId: "stable-group-id", personName: "成员甲" }));
    expect(normalized?.tokenSnapshot).toEqual(expect.objectContaining({ totalTokens: 3_500_000, deviceIds: ["Mac"] }));
    expect(normalized?.tokenSnapshot?.models[0].totalTokens).toBe(3_500_000);
    expect(normalizeComfortFeedbackRecord(normalized)).toEqual(normalized);
  });

  it("roundtrips a cost-share allocation without overwriting the shared quota percent", () => {
    const source = record({
      observedUsedPercent: 60,
      quotaAllocation: {
        metricVersion: "cost-share-v1",
        localDate: "2026-08-12",
        observedAt: "2026-08-13T02:00:00.000Z",
        totalUsedPercent: 99,
        personCostUsd: 30,
        totalCostUsd: 100,
        costShare: 0.9,
        allocatedUsedPercent: 99,
        coverage: "complete",
        deviceIds: ["Mac", "PC"],
        missingDeviceIds: [],
      },
    });
    const normalized = normalizeComfortFeedbackRecord(source);
    expect(normalized?.observedUsedPercent).toBe(60);
    expect(normalized?.quotaAllocation).toEqual(expect.objectContaining({ totalUsedPercent: 60, costShare: 0.3, allocatedUsedPercent: 18 }));
    expect(normalizeComfortFeedbackRecord(normalized)).toEqual(normalized);
    expect(normalizeComfortQuotaAllocation({ ...source.quotaAllocation!, personCostUsd: -1 }, source.localDate, 60)).toBeNull();
  });

  it("keeps a history-derived allocation when the legacy quota observation is missing", () => {
    const source = record({
      observedUsedPercent: null,
      quotaAllocation: {
        metricVersion: "cost-share-v1",
        localDate: "2026-08-12",
        observedAt: "2026-08-13T02:00:00.000Z",
        totalUsedPercent: 60,
        personCostUsd: 30,
        totalCostUsd: 100,
        costShare: 0.3,
        allocatedUsedPercent: 18,
        coverage: "complete",
        deviceIds: ["Mac", "PC"],
        missingDeviceIds: [],
      },
    });
    const normalized = normalizeComfortFeedbackRecord(source);
    expect(normalized?.observedUsedPercent).toBeNull();
    expect(normalized?.quotaAllocation).toEqual(expect.objectContaining({ totalUsedPercent: 60, allocatedUsedPercent: 18 }));
    expect(normalizeComfortFeedbackRecord(normalized)).toEqual(normalized);
  });

  it("drops only a malformed optional allocation and preserves the subjective feedback", () => {
    const source = record({
      quotaAllocation: {
        metricVersion: "cost-share-v1",
        localDate: "2026-08-12",
        observedAt: "2026-08-13T02:00:00.000Z",
        totalUsedPercent: 60,
        personCostUsd: -1,
        totalCostUsd: 100,
        costShare: 0.3,
        allocatedUsedPercent: 18,
        coverage: "complete",
        deviceIds: ["Mac"],
        missingDeviceIds: [],
      },
    });
    expect(normalizeComfortFeedbackRecord(source)).toEqual(expect.objectContaining({
      localDate: "2026-08-12",
      comfort: "comfortable",
      quotaAllocation: null,
    }));
  });

  it("bounds feedback per person and refuses to mix people in the legacy quota curve", () => {
    const many = Array.from({ length: 95 }, (_, index) => record({
      localDate: `2026-${String(5 + Math.floor(index / 28)).padStart(2, "0")}-${String(index % 28 + 1).padStart(2, "0")}`,
      observedAt: new Date(Date.UTC(2026, 4, index + 1)).toISOString(),
      personId: "alex",
    }));
    const other = record({ personId: "blair", localDate: "2026-08-12" });
    const normalized = normalizeComfortFeedbackRecords([...many, other]);
    expect(normalized.filter(item => item.personId === "alex")).toHaveLength(90);
    expect(normalized.filter(item => item.personId === "blair")).toHaveLength(1);
    expect(personalizeComfortCurve([record({ personId: "alex" }), other]).mode).toBe("baseline-fallback");
    expect(personalizeComfortCurve([record({ personId: "alex" }), other], new Date(), "alex").sampleCount).toBe(1);
  });
});

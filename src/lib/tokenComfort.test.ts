import { describe, expect, it } from "vitest";
import type { ComfortCode, ComfortFeedbackRecord } from "../types";
import type { DailyModelUsage, ModelUsage, TokeiDevice, TokeiUsage } from "./tokeiUsage";
import { COMFORT_CURVE_VERSION } from "./comfortFeedback";
import {
  buildTokenComfortModel,
  buildTokenComfortSnapshot,
  COMFORT_TOKEN_METRIC_VERSION,
  TOKEN_COMFORT_MIN_COMPLETE_DAYS,
} from "./tokenComfort";

const targetDate = "2026-09-09";
const dayEnd = new Date(2026, 8, 10, 0, 0, 0, 0);
const fetchedAt = new Date(2026, 8, 10, 12, 0, 0, 0);

function model(id: string, input: number, cached: number, output: number, reasoning = 0): ModelUsage {
  return {
    id,
    name: `Model ${id}`,
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningTokens: reasoning,
    totalTokens: input + cached + output,
    estimatedCostUsd: null,
  };
}

function day(...models: ModelUsage[]): DailyModelUsage {
  return {
    inputTokens: models.reduce((sum, item) => sum + item.inputTokens, 0),
    cachedInputTokens: models.reduce((sum, item) => sum + item.cachedInputTokens, 0),
    outputTokens: models.reduce((sum, item) => sum + item.outputTokens, 0),
    reasoningTokens: models.reduce((sum, item) => sum + item.reasoningTokens, 0),
    totalTokens: models.reduce((sum, item) => sum + item.totalTokens, 0),
    estimatedCostUsd: null,
    models,
  };
}

function device(id: string, daily: Record<string, DailyModelUsage>, overrides: Partial<TokeiDevice> = {}): TokeiDevice {
  return { id, updatedAt: fetchedAt.toISOString(), stale: false, daily, ranges: {}, ...overrides };
}

function usage(devices: TokeiDevice[], deviceIds = devices.map(item => item.id)): TokeiUsage {
  return {
    fetchedAt: fetchedAt.toISOString(),
    status: "ready",
    groups: [{ id: "alex", name: "成员甲", deviceIds }],
    defaultGroupId: "alex",
    devices,
    warnings: [],
    projectBreakdownAvailable: true,
  };
}

function feedback(
  localDate: string,
  totalTokens: number,
  comfort: ComfortCode,
  coverage: "complete" | "partial" = "complete",
  personId = "alex",
): ComfortFeedbackRecord {
  const observedAt = new Date(`${localDate}T12:00:00.000Z`).toISOString();
  return {
    localDate,
    observedAt,
    comfort,
    personId,
    personName: personId,
    observedUsedPercent: 25,
    usageObservedAt: observedAt,
    usageCoverage: "complete",
    usageSource: "official-snapshot",
    curveVersion: COMFORT_CURVE_VERSION,
    tokenSnapshot: {
      localDate,
      observedAt,
      metricVersion: COMFORT_TOKEN_METRIC_VERSION,
      coverage,
      inputTokens: totalTokens,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens,
      models: [],
      deviceIds: ["Mac"],
      missingDeviceIds: [],
      incompleteDeviceIds: coverage === "complete" ? [] : ["Mac"],
    },
  };
}

describe("person token comfort snapshots", () => {
  it("aggregates exact calendar-day token dimensions across the selected group's devices", () => {
    const snapshot = buildTokenComfortSnapshot(usage([
      device("Mac", { [targetDate]: day(model("a", 1_000_000, 2_000_000, 500_000, 100_000)) }),
      device("PC", { [targetDate]: day(model("a", 200_000, 300_000, 100_000, 20_000), model("b", 400_000, 300_000, 200_000)) }),
    ]), "alex", targetDate, fetchedAt);

    expect(snapshot).toEqual(expect.objectContaining({
      coverage: "complete",
      inputTokens: 1_600_000,
      cachedInputTokens: 2_600_000,
      outputTokens: 800_000,
      reasoningTokens: 120_000,
      totalTokens: 5_000_000,
      deviceIds: ["Mac", "PC"],
      missingDeviceIds: [],
      incompleteDeviceIds: [],
    }));
    expect(snapshot?.models).toEqual([
      expect.objectContaining({ id: "a", totalTokens: 4_100_000 }),
      expect.objectContaining({ id: "b", totalTokens: 900_000 }),
    ]);
  });

  it("never infers a missing calendar ledger day as a complete zero", () => {
    const present = device("Mac", { [targetDate]: day(model("a", 1_000_000, 0, 0)) });
    const missing = device("PC", {});
    expect(buildTokenComfortSnapshot(usage([present, missing]), "alex", targetDate, fetchedAt)).toEqual(expect.objectContaining({
      coverage: "partial",
      totalTokens: 1_000_000,
      incompleteDeviceIds: ["PC"],
    }));
    expect(buildTokenComfortSnapshot(usage([missing]), "alex", targetDate, fetchedAt)).toEqual(expect.objectContaining({
      coverage: "unavailable",
      totalTokens: 0,
      incompleteDeviceIds: ["PC"],
    }));
    const rangeOnly = device("Mac", {}, { ranges: { all: { ...day(model("a", 1_000_000, 0, 0)), start: null, end: null } } });
    expect(buildTokenComfortSnapshot(usage([rangeOnly]), "alex", targetDate, fetchedAt)?.coverage).toBe("unavailable");
  });

  it("marks current, stale, future-timestamped, and truncated model detail incomplete", () => {
    const currentDate = "2026-09-10";
    const current = device("Mac", { [currentDate]: day(model("a", 1, 2, 3)) });
    expect(buildTokenComfortSnapshot(usage([current]), "alex", currentDate, fetchedAt)?.coverage).toBe("partial");

    const future = device("Mac", { [targetDate]: day(model("a", 1, 2, 3)) }, { updatedAt: new Date(fetchedAt.getTime() + 3600_000).toISOString() });
    expect(buildTokenComfortSnapshot(usage([future]), "alex", targetDate, fetchedAt)).toEqual(expect.objectContaining({ coverage: "partial", incompleteDeviceIds: ["Mac"] }));

    const tooManyModels = Array.from({ length: 129 }, (_, index) => model(`m${index}`, 1, 0, 0));
    const truncated = buildTokenComfortSnapshot(usage([device("Mac", { [targetDate]: day(...tooManyModels) })]), "alex", targetDate, fetchedAt);
    expect(truncated?.models).toHaveLength(128);
    expect(truncated).toEqual(expect.objectContaining({ coverage: "partial", totalTokens: 129, incompleteDeviceIds: ["Mac"] }));
  });

  it("does not use the quota 04:00 partition when deciding calendar-day completeness", () => {
    const justAfterMidnight = new Date(dayEnd.getTime() + 60_000);
    const data = usage([device("Mac", { [targetDate]: day(model("a", 1, 0, 0)) }, { updatedAt: justAfterMidnight.toISOString() })]);
    data.fetchedAt = justAfterMidnight.toISOString();
    expect(buildTokenComfortSnapshot(data, "alex", targetDate, justAfterMidnight)?.coverage).toBe("complete");
  });
});

describe("person token comfort descriptive model", () => {
  it("shows partial points in scatter but excludes them from a sub-threshold fit", () => {
    const records = Array.from({ length: TOKEN_COMFORT_MIN_COMPLETE_DAYS - 1 }, (_, index) => feedback(
      `2026-09-0${index + 1}`,
      (index + 1) * 1_000_000,
      index < 2 ? "idle" : index < 4 ? "comfortable" : "overloaded",
    ));
    records.push(feedback("2026-09-07", 8_000_000, "overloaded", "partial"));
    records.push(feedback("2026-09-08", 99_000_000, "overloaded", "complete", "blair"));
    const result = buildTokenComfortModel(records, "alex", fetchedAt);

    expect(result).toEqual(expect.objectContaining({ mode: "scatter-only", sampleCount: 7, completeSampleCount: 6, trend: null }));
    expect(result.observations.at(-1)).toEqual(expect.objectContaining({ tokenMillions: 8, coverage: "partial", eligibleForFit: false }));
  });

  it("builds only an in-range binned ordinal mean after seven varying complete days", () => {
    const records = Array.from({ length: 7 }, (_, index) => feedback(
      `2026-09-0${index + 1}`,
      (index + 1) * 1_000_000,
      index < 2 ? "idle" : index < 5 ? "comfortable" : "overloaded",
    ));
    const result = buildTokenComfortModel(records, "alex", fetchedAt);

    expect(result).toEqual(expect.objectContaining({ mode: "empirical-fit", completeSampleCount: 7, distinctTokenCount: 7 }));
    expect(result.trend?.method).toBe("binned-ordinal-mean-v1");
    expect(result.trend?.points).toHaveLength(3);
    expect(Math.min(...result.trend!.points.map(point => point.minTokenMillions))).toBe(1);
    expect(Math.max(...result.trend!.points.map(point => point.maxTokenMillions))).toBe(7);
    expect(result.trend?.points.every(point => point.comfortScore >= 0 && point.comfortScore <= 2)).toBe(true);
  });

  it("defensively excludes future and internally inconsistent snapshots", () => {
    const future = feedback("2026-09-11", 2_000_000, "comfortable");
    const inconsistent = feedback("2026-09-08", 2_000_000, "comfortable");
    inconsistent.tokenSnapshot!.totalTokens = 25_000_000;
    expect(buildTokenComfortModel([future, inconsistent], "alex", fetchedAt)).toEqual(expect.objectContaining({ sampleCount: 0, mode: "scatter-only" }));
  });
});

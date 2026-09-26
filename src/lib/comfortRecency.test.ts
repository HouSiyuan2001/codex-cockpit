import { expect, it } from "vitest";
import { COMFORT_CURVE_VERSION, comfortFeedbackWeight, normalizeComfortFeedbackRecord, personalizeComfortCurve } from "./comfortFeedback";
import type { ComfortFeedbackRecord } from "../types";

const now = new Date(2026, 8, 9, 12);
const record = (localDate: string, comfort: ComfortFeedbackRecord["comfort"] = "comfortable", used = 35): ComfortFeedbackRecord => ({
  localDate, comfort, observedUsedPercent: used, observedAt: now.toISOString(), usageObservedAt: null,
  usageCoverage: "complete", usageSource: "official-snapshot", curveVersion: COMFORT_CURVE_VERSION,
});

it("halves by experience date every 14 days and retains coverage reliability", () => {
  expect(comfortFeedbackWeight(record("2026-09-09"), now)).toBe(1);
  expect(comfortFeedbackWeight(record("2026-08-26"), now)).toBe(0.5);
  expect(comfortFeedbackWeight(record("2026-08-12"), now)).toBe(0.25);
  expect(comfortFeedbackWeight({ ...record("2026-08-26"), usageCoverage: "partial" }, now)).toBe(0.375);
  expect(comfortFeedbackWeight({ ...record("2026-08-26"), observedAt: "2026-09-09T20:00:00Z" }, now)).toBe(0.5);
  expect(comfortFeedbackWeight(record("2026-09-10"), now)).toBe(0);
  expect(comfortFeedbackWeight(record("bad date"), now)).toBe(0);
});

it("follows recent contradictory feedback more strongly than old feedback", () => {
  const recentHigherTolerance = [record("2026-08-12", "overloaded"), record("2026-09-09", "idle")];
  const recentLowerTolerance = [record("2026-08-12", "idle"), record("2026-09-09", "overloaded")];
  const higher = personalizeComfortCurve(recentHigherTolerance, now);
  const lower = personalizeComfortCurve(recentLowerTolerance, now);
  expect(higher.xStarPercent).toBeGreaterThan(lower.xStarPercent);
  expect(higher.sampleCount).toBe(2);
  expect(higher.weightedSampleCount).toBe(1.25);
  expect(higher.observations.map(o => o.fitWeight)).toEqual([0.25, 1]);
  expect(personalizeComfortCurve([...recentHigherTolerance].reverse(), now).xStarPercent).toBe(higher.xStarPercent);
});

it("ages confidence without new feedback and preserves the input observations", () => {
  const records = [record("2026-09-08", "comfortable", 40), record("2026-09-09", "overloaded", 55)];
  const saved = JSON.stringify(records);
  const fresh = personalizeComfortCurve(records, now);
  const later = personalizeComfortCurve(records, new Date(2026, 9, 7, 12));
  expect(later.weightedSampleCount).toBeLessThan(fresh.weightedSampleCount!);
  expect(later.confidence).toBeLessThan(fresh.confidence);
  expect(later.sampleCount).toBe(fresh.sampleCount);
  expect(JSON.stringify(records)).toBe(saved);
  const future = personalizeComfortCurve([record("2026-09-10")], now);
  expect(future.mode).toBe("baseline-fallback");
});

it("keeps the previous installed feedback format readable", () => {
  const old = { ...record("2026-08-26"), curveVersion: "p014-t014-ordinal-map-v3" };
  expect(normalizeComfortFeedbackRecord(old)).toEqual({
    ...old,
    curveVersion: COMFORT_CURVE_VERSION,
    personId: null,
    personName: null,
    tokenSnapshot: null,
    quotaAllocation: null,
  });
});

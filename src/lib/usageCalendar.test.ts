import { describe, expect, it } from "vitest";
import { aggregateGroupUsage, createUsagePreview } from "./tokeiUsage";
import { calendarModelSegments, calendarMonthCellCount, calendarRange, calendarValue, isoWeekNumber, usageInRange } from "./usageCalendar";

describe("calendar ledger boundaries", () => {
  it("uses only the weeks actually intersecting the month", () => {
    expect(calendarMonthCellCount(2021, 1)).toBe(28);
    expect(calendarMonthCellCount(2026, 8)).toBe(35);
    expect(calendarMonthCellCount(2026, 7)).toBe(42);
  });
  it("keeps per-model ring segments distinct without counting duplicate devices", () => {
    const now = new Date(2026, 8, 22, 12), device = createUsagePreview(now).devices[0];
    const range = calendarRange(now, "day");
    expect(calendarModelSegments([device, device], range, "cost", now)).toEqual([
      { id: "demo-a", value: 2.4 }, { id: "demo-b", value: 0.3 },
    ]);
    device.daily[range.start].models[1].estimatedCostUsd = null;
    expect(calendarModelSegments([device], range, "cost", now)).toEqual([{ id: "demo-a", value: 2.4 }]);
  });
  it("handles leap months, Monday weeks crossing years, quarters and full years", () => {
    expect(calendarRange(new Date(2024, 1, 17, 12), "month")).toEqual({ start: "2024-02-01", end: "2024-02-29", scale: "month" });
    expect(calendarRange(new Date(2026, 0, 1, 12), "week")).toEqual({ start: "2025-12-29", end: "2026-01-04", scale: "week" });
    expect(isoWeekNumber(new Date(2025, 11, 29, 12))).toBe(1);
    expect(calendarRange(new Date(2026, 8, 17, 12), "quarter")).toEqual({ start: "2026-07-01", end: "2026-09-30", scale: "quarter" });
    expect(calendarRange(new Date(2026, 8, 17, 12), "year").end).toBe("2026-12-31");
  });
  it("distinguishes missing, explicit zero and partial known costs without duplicate devices", () => {
    const now = new Date(2026, 8, 22, 12), data = createUsagePreview(now), device = data.devices[0];
    const range = calendarRange(now, "day"), day = device.daily[range.start];
    expect(calendarValue([device, device], range, "cost", now).value).toBeCloseTo(2.7);
    day.estimatedCostUsd = null;
    day.models[1].estimatedCostUsd = null;
    expect(calendarValue([device], range, "cost", now)).toEqual({ value: 2.4, partial: true });
    day.totalTokens = 0;
    expect(calendarValue([device], range, "tokens", now).value).toBe(0);
    expect(calendarValue([device], calendarRange(new Date(2026, 8, 21, 12), "day"), "tokens", now).value).toBeNull();
  });
  it("filters exact historical days, excludes future days and never spreads a range snapshot", () => {
    const now = new Date(2026, 8, 22, 12), data = createUsagePreview(now), device = data.devices[0];
    const day = device.daily["2026-09-22"];
    device.daily["2026-08-18"] = day;
    device.daily["2026-12-25"] = day;
    device.ranges["all"] = { ...day, totalTokens: 9e9, start: null, end: null };
    const range = calendarRange(new Date(2026, 7, 18, 12), "day");
    const filtered = usageInRange(data, range, now);
    expect(aggregateGroupUsage(filtered, "demo", "all", now).totalTokens).toBe(day.totalTokens);
    expect(Object.keys(filtered.devices[0].daily)).toEqual(["2026-08-18"]);
    expect(filtered.devices[0].ranges).toEqual({});
    expect(Object.keys(usageInRange(data, calendarRange(now, "year"), now).devices[0].daily)).not.toContain("2026-12-25");
  });
  it("marks sparse months, missing devices and stale ledgers partial without inventing zeros", () => {
    const now = new Date(2026, 8, 22, 12), device = createUsagePreview(now).devices[0];
    const day = device.daily["2026-09-22"];
    const range = calendarRange(new Date(2026, 7, 18, 12), "month");
    device.daily = { "2026-08-18": day };
    expect(calendarValue([device], range, "cost", now).value).toBeCloseTo(2.7);
    expect(calendarValue([device], range, "cost", now).partial).toBe(true);
    device.daily = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`2026-08-${String(i + 1).padStart(2, "0")}`, { ...day, totalTokens: 0, estimatedCostUsd: 0, models: [] }]));
    expect(calendarValue([device], range, "cost", now)).toEqual({ value: 0, partial: false });
    expect(calendarValue([device, { ...device, id: "missing", daily: {} }], range, "cost", now)).toEqual({ value: 0, partial: true });
    expect(calendarValue([{ ...device, stale: true }], range, "tokens", now)).toEqual({ value: 0, partial: true });
    expect(calendarValue([device], calendarRange(now, "day"), "cost", now)).toEqual({ value: null, partial: true });
  });
});

import { describe, expect, it } from "vitest";
import {
  buildQuotaTrendGeometry,
  buildUsageCalendar,
  mondayWeekdayIndex,
  observedTrendUse,
  recentQuotaTrend,
  usageSummary,
} from "./usageInsights";
import type { QuotaHistoryPoint } from "../types";

const history: QuotaHistoryPoint[] = [
  { provider: "codex", capturedAt: "2026-08-07T01:00:00Z", metric: 90, metricKind: "percent", status: "ok", resetsAt: "2026-08-12T00:00:00Z" },
  { provider: "codex", capturedAt: "2026-08-07T02:00:00Z", metric: 84, metricKind: "percent", status: "ok", resetsAt: "2026-08-12T00:00:00Z" },
  { provider: "codex", capturedAt: "2026-08-08T02:00:00Z", metric: 80, metricKind: "percent", status: "ok", resetsAt: "2026-08-12T00:00:00Z" },
];

describe("usage insights", () => {
  it("builds an honest 90-day calendar and recovers observed use from history", () => {
    const days = buildUsageCalendar([], history, "codex", new Date("2026-08-08T08:00:00Z"));
    expect(days).toHaveLength(90);
    expect(days.at(-1)?.observedUsedPercent).toBe(4);
    expect(usageSummary(days)).toEqual(expect.objectContaining({ activeDays: 2, observedUsedPercent: 10 }));
    expect(days[0].observedUsedPercent).toBeNull();
  });

  it("prefers persisted summaries when they contain more complete observation", () => {
    const days = buildUsageCalendar([{
      provider: "codex", localDate: "2026-08-08", observedUsedPercent: 11, sampleCount: 8, updatedAt: "2026-08-08T08:00:00Z",
    }], history, "codex", new Date("2026-08-08T08:00:00Z"));
    expect(days.at(-1)).toEqual(expect.objectContaining({ observedUsedPercent: 11, sampleCount: 8, level: 3 }));
  });

  it("returns recent remaining-quota points for the trajectory", () => {
    const points = recentQuotaTrend(history, "codex", 79, new Date("2026-08-08T08:00:00Z"));
    expect(points.at(-1)?.remainingPercent).toBe(79);
    expect(points.length).toBeGreaterThanOrEqual(2);
  });

  it("does not label old history as a 24-hour trajectory", () => {
    const oldHistory: QuotaHistoryPoint[] = [
      { provider: "codex", capturedAt: "2026-07-20T01:00:00Z", metric: 90, metricKind: "percent", status: "ok", resetsAt: "2026-07-25T00:00:00Z" },
      { provider: "codex", capturedAt: "2026-07-20T02:00:00Z", metric: 80, metricKind: "percent", status: "ok", resetsAt: "2026-07-25T00:00:00Z" },
    ];

    const points = recentQuotaTrend(oldHistory, "codex", null, new Date("2026-08-08T08:00:00Z"));

    expect(points).toEqual([]);
  });

  it("aligns calendar rows to the Monday-first weekday labels", () => {
    expect(mondayWeekdayIndex(new Date(2026, 7, 3, 12))).toBe(0);
    expect(mondayWeekdayIndex(new Date(2026, 7, 9, 12))).toBe(6);
  });

  it("keeps the trajectory within the requested time window and extends a flat reading to now", () => {
    const now = new Date("2026-08-08T08:00:00Z");
    const boundedHistory: QuotaHistoryPoint[] = [
      { provider: "codex", capturedAt: "2026-08-08T06:00:00Z", metric: 75, metricKind: "percent", status: "ok", resetsAt: null },
      { provider: "codex", capturedAt: "2026-08-08T09:00:00Z", metric: 50, metricKind: "percent", status: "ok", resetsAt: null },
    ];

    const points = recentQuotaTrend(boundedHistory, "codex", 75, now);

    expect(points).toEqual([
      { capturedAt: "2026-08-08T06:00:00Z", remainingPercent: 75 },
      { capturedAt: now.toISOString(), remainingPercent: 75 },
    ]);
  });

  it("spaces trajectory points according to capture time", () => {
    const now = new Date("2026-08-08T08:00:00Z");
    const geometry = buildQuotaTrendGeometry([
      { capturedAt: "2026-08-07T08:00:00Z", remainingPercent: 90 },
      { capturedAt: "2026-08-07T09:00:00Z", remainingPercent: 80 },
      { capturedAt: now.toISOString(), remainingPercent: 70 },
    ], now);

    expect(geometry).not.toBeNull();
    expect(geometry!.points[1].x - geometry!.points[0].x).toBeCloseTo(212 / 24, 1);
    expect(geometry!.points[2].x).toBe(216);
  });

  it("counts observed use across a quota reset without letting the refill cancel it", () => {
    expect(observedTrendUse([
      { capturedAt: "2026-08-08T01:00:00Z", remainingPercent: 30 },
      { capturedAt: "2026-08-08T02:00:00Z", remainingPercent: 20 },
      { capturedAt: "2026-08-08T03:00:00Z", remainingPercent: 100 },
      { capturedAt: "2026-08-08T04:00:00Z", remainingPercent: 90 },
    ])).toBe(20);
  });
});

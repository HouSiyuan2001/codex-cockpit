import { describe, expect, it } from "vitest";
import type { QuotaHistoryPoint } from "../types";
import { buildOfficialDailyUsageForDate, buildOfficialDailyUsageHistory, compactOfficialQuotaHistory } from "./officialUsage";

const RESET = "2026-08-20T04:43:01.000Z";
const OLD_RESET = "2026-08-18T00:02:47.000Z";
const RESET_IN_DAY = "2026-08-21T04:43:01.000Z";

function point(capturedAt: string, metric: number, resetsAt = RESET): QuotaHistoryPoint {
  return { provider: "codex", capturedAt, metric, metricKind: "percent", status: "ok", resetsAt };
}

describe("official daily usage", () => {
  it("uses Beijing midnight official remaining-percent drops", () => {
    const history = [
      point("2026-08-13T15:55:00.000Z", 90, RESET),
      point("2026-08-13T16:00:00.000Z", 90, RESET),
      point("2026-08-13T16:30:00.000Z", 88, RESET),
      point("2026-08-14T12:00:00.000Z", 42, RESET),
    ];
    const usage = buildOfficialDailyUsageForDate("2026-08-14", history, new Date("2026-08-14T13:00:00.000Z"));
    expect(usage).toMatchObject({ localDate: "2026-08-14", observedUsedPercent: 48, coverage: "complete", sampleCount: 3 });
  });

  it("adds the post-reset segment without mixing the old cycle", () => {
    const history = [
      point("2026-08-13T15:55:00.000Z", 80, OLD_RESET),
      point("2026-08-13T16:05:00.000Z", 80, OLD_RESET),
      point("2026-08-13T19:00:00.000Z", 70, OLD_RESET),
      point("2026-08-14T15:00:00.000Z", 95, RESET_IN_DAY),
      point("2026-08-14T15:55:00.000Z", 93, RESET_IN_DAY),
    ];
    const usage = buildOfficialDailyUsageForDate("2026-08-14", history, new Date("2026-08-14T17:00:00.000Z"));
    expect(usage).toMatchObject({ observedUsedPercent: 17, coverage: "complete" });
  });

  it("marks a reset day partial when the pre-reset official segment is missing", () => {
    const history = [
      point("2026-08-13T15:00:00.000Z", 95, RESET),
      point("2026-08-13T15:55:00.000Z", 93, RESET),
    ];
    const usage = buildOfficialDailyUsageForDate("2026-08-13", history, new Date("2026-08-13T17:00:00.000Z"));
    expect(usage).toMatchObject({ observedUsedPercent: 7, coverage: "partial" });
  });

  it("ignores remaining-percent rebounds instead of inventing negative usage", () => {
    const history = [
      point("2026-08-14T11:00:00.000Z", 60),
      point("2026-08-14T11:10:00.000Z", 65),
      point("2026-08-14T11:20:00.000Z", 58),
    ];
    const usage = buildOfficialDailyUsageForDate("2026-08-14", history, new Date("2026-08-14T11:30:00.000Z"));
    expect(usage?.observedUsedPercent).toBe(2);
  });

  it("builds the current day from the live official snapshot as well as persisted history", () => {
    const history = [point("2026-08-14T11:00:00.000Z", 60)];
    const result = buildOfficialDailyUsageHistory(history, {
      provider: "codex",
      displayName: "CODEX",
      plan: "Pro",
      shortWindow: null,
      weeklyWindow: { remainingPercent: 55, resetsAt: RESET, windowSeconds: 604_800 },
      resetCredits: null,
      updatedAt: "2026-08-14T11:30:00.000Z",
      status: "ok",
      message: null,
    }, new Date("2026-08-14T11:30:00.000Z"));
    expect(result[0]).toMatchObject({ localDate: "2026-08-14", observedUsedPercent: 5 });
  });
  it("adds pre-reset and new-cycle usage across midnight, independently of host timezone", () => {
    const reset = "2026-11-03T03:07:00Z";
    const old = "2026-10-27T03:07:00Z";
    const points = [point("2026-10-26T16:00:00Z", 39, old), point("2026-10-27T03:06:00Z", 24, old), point("2026-10-27T03:08:00Z", 100, reset), point("2026-10-27T06:00:00Z", 15, reset)];
    expect(buildOfficialDailyUsageForDate("2026-10-27", points, new Date("2026-10-27T06:00:00Z"))).toMatchObject({ observedUsedPercent: 100 });
  });
  it("does not move an old live snapshot to the current calendar day", () => {
    const snapshot = { provider: "codex" as const, displayName: "Codex", plan: "Pro", shortWindow: null, weeklyWindow: { remainingPercent: 55, resetsAt: RESET, windowSeconds: 604800 }, resetCredits: null, updatedAt: "2026-08-13T15:50:00Z", status: "ok" as const, message: null };
    const history = buildOfficialDailyUsageHistory([], snapshot, new Date("2026-08-14T08:00:00Z"));
    expect(history.map(day => day.localDate)).toEqual(["2026-08-13"]);
    expect(history[0].coverage).toBe("partial");
  });
  it("requires end-of-day observations before claiming complete historical coverage", () => {
    expect(buildOfficialDailyUsageForDate("2026-10-27", [point("2026-10-26T16:00:00Z", 80), point("2026-10-27T01:00:00Z", 70)], new Date("2026-10-28T06:00:00Z"))?.coverage).toBe("partial");
  });

  it("ignores delayed old-cycle readings after a reset", () => {
    const old = "2026-10-27T03:00:00Z", reset = "2026-11-03T03:00:00Z";
    const points = [point("2026-10-26T16:00:00Z", 40, old), point("2026-10-27T02:59:00Z", 0, old), point("2026-10-27T03:01:00Z", 90, reset), point("2026-10-27T03:02:00Z", 0, old), point("2026-10-27T04:00:00Z", 80, reset)];
    expect(buildOfficialDailyUsageForDate("2026-10-27", points, new Date("2026-10-27T04:00:00Z"))?.observedUsedPercent).toBe(60);
  });
  it("retains day endpoints and extrema when compacted history is restored", () => {
    const points = Array.from({ length: 100 }, (_, i) => point(new Date(Date.parse("2026-10-26T16:00:00Z") + i * 60000).toISOString(), i === 40 ? 5 : 80-i/2, "2026-11-01T03:00:00Z"));
    const compact = compactOfficialQuotaHistory(points);
    expect(compact.length).toBeLessThanOrEqual(4);
    expect(compact.map(p => p.metric)).toContain(5);
    expect(compact[0]).toEqual(points[0]);
    expect(compact.at(-1)).toEqual(points.at(-1));
    expect(buildOfficialDailyUsageForDate("2026-10-27", compact, new Date("2026-10-27T04:00:00Z"))?.observedUsedPercent).toBe(75);
  });

});

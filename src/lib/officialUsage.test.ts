import { describe, expect, it } from "vitest";
import type { QuotaHistoryPoint } from "../types";
import { buildOfficialDailyUsageForDate, buildOfficialDailyUsageHistory } from "./officialUsage";

const RESET = "2026-08-20T04:43:01.000Z";
const OLD_RESET = "2026-08-18T00:02:47.000Z";
const RESET_IN_DAY = "2026-08-21T04:43:01.000Z";

function point(capturedAt: string, metric: number, resetsAt = RESET): QuotaHistoryPoint {
  return { provider: "codex", capturedAt, metric, metricKind: "percent", status: "ok", resetsAt };
}

describe("official daily usage", () => {
  it("uses Beijing 04:00 official remaining-percent drops", () => {
    const history = [
      point("2026-08-13T19:55:00.000Z", 90, RESET),
      point("2026-08-13T20:00:00.000Z", 90, RESET),
      point("2026-08-13T20:30:00.000Z", 88, RESET),
      point("2026-08-14T12:00:00.000Z", 42, RESET),
    ];
    const usage = buildOfficialDailyUsageForDate("2026-08-14", history, new Date("2026-08-14T13:00:00.000Z"));
    expect(usage).toMatchObject({ localDate: "2026-08-14", observedUsedPercent: 48, coverage: "complete", sampleCount: 3 });
  });

  it("adds the post-reset segment without mixing the old cycle", () => {
    const history = [
      point("2026-08-13T19:55:00.000Z", 80, OLD_RESET),
      point("2026-08-13T20:05:00.000Z", 80, OLD_RESET),
      point("2026-08-13T23:00:00.000Z", 70, OLD_RESET),
      point("2026-08-14T15:00:00.000Z", 95, RESET_IN_DAY),
      point("2026-08-14T16:00:00.000Z", 93, RESET_IN_DAY),
    ];
    const usage = buildOfficialDailyUsageForDate("2026-08-14", history, new Date("2026-08-14T17:00:00.000Z"));
    expect(usage).toMatchObject({ observedUsedPercent: 17, coverage: "complete" });
  });

  it("marks a reset day partial when the pre-reset official segment is missing", () => {
    const history = [
      point("2026-08-13T15:00:00.000Z", 95, RESET),
      point("2026-08-13T16:00:00.000Z", 93, RESET),
    ];
    const usage = buildOfficialDailyUsageForDate("2026-08-13", history, new Date("2026-08-13T17:00:00.000Z"));
    expect(usage).toMatchObject({ observedUsedPercent: 7, coverage: "partial" });
  });

  it("ignores remaining-percent rebounds instead of inventing negative usage", () => {
    const history = [
      point("2026-08-14T19:00:00.000Z", 60),
      point("2026-08-14T19:10:00.000Z", 65),
      point("2026-08-14T19:20:00.000Z", 58),
    ];
    const usage = buildOfficialDailyUsageForDate("2026-08-14", history, new Date("2026-08-14T19:30:00.000Z"));
    expect(usage?.observedUsedPercent).toBe(2);
  });

  it("builds the current day from the live official snapshot as well as persisted history", () => {
    const history = [point("2026-08-14T19:00:00.000Z", 60)];
    const result = buildOfficialDailyUsageHistory(history, {
      provider: "codex",
      displayName: "CODEX",
      plan: "Pro",
      shortWindow: null,
      weeklyWindow: { remainingPercent: 55, resetsAt: RESET, windowSeconds: 604_800 },
      resetCredits: null,
      updatedAt: "2026-08-14T20:30:00.000Z",
      status: "ok",
      message: null,
    }, new Date("2026-08-14T19:30:00.000Z"));
    expect(result[0]).toMatchObject({ localDate: "2026-08-14", observedUsedPercent: 5 });
  });
});

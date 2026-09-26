import { describe, expect, it } from "vitest";
import type { ProviderSnapshot, ResetForecast } from "../types";
import { calculateQuotaPace, forecastAdjustedResetAt, mostOverPaceWindow, paceBaselineKey, refreshDailyPaceBaselines, trackedQuotaWindows } from "./quotaPace";

function resetForecast(score: number, windowHours = 48): ResetForecast {
  return {
    score,
    windowHours,
    fetchedAt: "2026-07-22T00:00:00Z",
    resetAnnounced: false,
    sourceUrl: "https://codex-resets.com/",
  };
}

function codexSnapshot(remainingPercent: number, resetsAt: string): ProviderSnapshot {
  return {
    provider: "codex",
    displayName: "CODEX",
    plan: "PRO",
    shortWindow: null,
    weeklyWindow: { remainingPercent, resetsAt, windowSeconds: 604_800 },
    resetCredits: 0,
    updatedAt: "2026-07-20T00:00:00Z",
    status: "ok",
    message: null,
  };
}

describe("quota pace", () => {
  it("marks usage below the elapsed share as on track", () => {
    const pace = calculateQuotaPace(
      { remainingPercent: 90, resetsAt: "2026-07-20T05:00:00Z", windowSeconds: 18_000 },
      new Date("2026-07-20T02:00:00Z"),
    );
    expect(pace.status).toBe("on_track");
    expect(pace.recommendedUsedPercent).toBeCloseTo(40);
    expect(pace.todayRemainingPercent).toBeCloseTo(90);
    expect(pace.averageRate).toBeCloseTo(30);
    expect(pace.unit).toBe("hour");
  });

  it("reports how far usage is ahead of an even weekly pace", () => {
    const startsAt = new Date("2026-07-20T00:00:00+08:00");
    const now = new Date("2026-07-22T00:00:00+08:00");
    const resetsAt = new Date("2026-07-27T00:00:00+08:00");
    const pace = calculateQuotaPace(
      { remainingPercent: 50, resetsAt: resetsAt.toISOString(), windowSeconds: (resetsAt.getTime() - startsAt.getTime()) / 1000 },
      now,
    );
    expect(pace.status).toBe("over_pace");
    expect(pace.recommendedUsedPercent).toBeCloseTo(28.571, 2);
    expect(pace.todayRemainingPercent).toBeCloseTo(1.6667, 2);
    expect(pace.overByPercent).toBeCloseTo(21.429, 2);
    expect(pace.averageRate).toBeCloseTo(10, 2);
    expect(pace.unit).toBe("day");
  });

  it("keeps an unused session on track when the reset time is absent", () => {
    const pace = calculateQuotaPace({ remainingPercent: 100, resetsAt: null, windowSeconds: 18_000 });
    expect(pace.status).toBe("on_track");
    expect(pace.recommendedUsedPercent).toBeNull();
    expect(pace.todayRemainingPercent).toBeNull();
  });

  it("rebalances today's budget from the quota and time currently remaining", () => {
    const startsAt = new Date("2026-07-20T00:00:00+08:00");
    const resetsAt = new Date(startsAt.getTime() + 7 * 86_400_000);
    const pace = calculateQuotaPace(
      { remainingPercent: 90, resetsAt: resetsAt.toISOString(), windowSeconds: 604_800 },
      new Date("2026-07-22T12:00:00+08:00"),
    );
    expect(pace.todayRemainingPercent).toBeCloseTo(13.3333, 2);
    expect(pace.averageRate).toBeCloseTo(20, 2);
  });

  it("automatically increases tomorrow's budget when quota is conserved", () => {
    const startsAt = new Date("2026-07-20T00:00:00+08:00");
    const resetsAt = new Date(startsAt.getTime() + 7 * 86_400_000);
    const today = calculateQuotaPace(
      { remainingPercent: 80, resetsAt: resetsAt.toISOString(), windowSeconds: 604_800 },
      new Date("2026-07-22T04:00:00+08:00"),
    );
    const tomorrow = calculateQuotaPace(
      { remainingPercent: 75, resetsAt: resetsAt.toISOString(), windowSeconds: 604_800 },
      new Date("2026-07-23T04:00:00+08:00"),
    );

    expect(today.todayRemainingPercent).toBeCloseTo(16.5517, 2);
    expect(tomorrow.todayRemainingPercent).toBeCloseTo(19.5652, 2);
  });

  it("keeps the daily suggestion fixed while live usage spends against it", () => {
    const now = new Date("2026-07-22T08:00:00+08:00");
    const resetsAt = new Date("2026-07-25T20:00:00+08:00").toISOString();
    const [baseline] = Object.values(refreshDailyPaceBaselines({}, [codexSnapshot(70, resetsAt)], now));
    const initial = calculateQuotaPace(codexSnapshot(70, resetsAt).weeklyWindow!, now, baseline);
    const refreshed = calculateQuotaPace(
      codexSnapshot(65, resetsAt).weeklyWindow!,
      new Date("2026-07-22T13:00:00+08:00"),
      baseline,
    );

    expect(refreshed.averageRate).toBeCloseTo(initial.averageRate, 8);
    expect(refreshed.todayRemainingPercent).toBeCloseTo((initial.todayRemainingPercent ?? 0) - 5, 8);
  });

  it("charges Codex usage since reset against today's plan when tracking starts late", () => {
    const now = new Date("2026-07-22T08:00:00+08:00");
    const resetsAt = new Date("2026-07-27T08:00:00+08:00").toISOString();
    const baselines = refreshDailyPaceBaselines({}, [codexSnapshot(70, resetsAt)], now);
    const baseline = baselines[paceBaselineKey("codex", "weekly")];
    const pace = calculateQuotaPace(codexSnapshot(70, resetsAt).weeklyWindow!, now, baseline);

    expect(pace.usedPercent).toBe(30);
    expect(pace.todayUsedPercent).toBe(30);
    expect(pace.todayRemainingPercent).toBeCloseTo(10.47619, 6);
  });

  it("restarts the consumption estimate after an early Codex reset", () => {
    const now = new Date("2026-07-22T08:00:00+08:00");
    const resetsAt = new Date("2026-08-03T08:00:00+08:00").toISOString();
    const baselines = refreshDailyPaceBaselines(
      {},
      [codexSnapshot(100, resetsAt)],
      now,
      new Set(["codex"]),
      resetForecast(90),
    );
    const baseline = baselines[paceBaselineKey("codex", "weekly")];
    const pace = calculateQuotaPace(codexSnapshot(100, resetsAt).weeklyWindow!, now, baseline);

    expect(baseline.capturedAt).toBe(now.toISOString());
    expect(pace.status).toBe("on_track");
    expect(pace.usedPercent).toBe(0);
    expect(pace.recommendedUsedPercent).toBeCloseTo(0, 8);
    expect(pace.todayRemainingPercent).not.toBeNull();
    expect(pace.averageRate).toBeGreaterThan(0);

    const tracked = calculateQuotaPace(
      codexSnapshot(95, resetsAt).weeklyWindow!,
      new Date("2026-07-22T09:00:00+08:00"),
      baseline,
    );
    expect(tracked.usedPercent).toBe(5);
  });

  it("weights the Radar reset window against the guaranteed weekly reset", () => {
    const now = new Date("2026-07-22T04:00:00+08:00");
    const resetsAt = new Date("2026-07-27T04:00:00+08:00").toISOString();
    const adjusted = Date.parse(forecastAdjustedResetAt(resetsAt, now, resetForecast(80)));

    // 80% × the 24h window midpoint + 20% × the guaranteed 120h reset = 43.2h.
    expect((adjusted - now.getTime()) / 3_600_000).toBeCloseTo(43.2, 8);
  });

  it("falls back to the weekly reset when the Radar forecast is invalid", () => {
    const now = new Date("2026-07-22T00:00:00+08:00");
    const resetsAt = new Date("2026-07-27T00:00:00+08:00").toISOString();

    expect(forecastAdjustedResetAt(resetsAt, now, { ...resetForecast(80), score: Number.NaN })).toBe(resetsAt);
  });

  it("captures Radar once per day and applies it to the daily suggestion", () => {
    const now = new Date("2026-07-22T04:00:00+08:00");
    const resetsAt = new Date("2026-07-27T04:00:00+08:00").toISOString();
    const first = refreshDailyPaceBaselines({}, [codexSnapshot(70, resetsAt)], now, new Set(), resetForecast(80));
    const baseline = first[paceBaselineKey("codex", "weekly")];
    const pace = calculateQuotaPace(codexSnapshot(70, resetsAt).weeklyWindow!, now, baseline);
    const sameDay = refreshDailyPaceBaselines(
      first,
      [codexSnapshot(65, resetsAt)],
      new Date("2026-07-22T12:00:00+08:00"),
      new Set(),
      resetForecast(10),
    );

    expect(baseline.resetForecastScore).toBe(80);
    expect(baseline.resetForecastWindowHours).toBe(48);
    expect((Date.parse(baseline.planningResetsAt) - now.getTime()) / 3_600_000).toBeCloseTo(43.2, 8);
    expect(pace.averageRate).toBeCloseTo(70 / 1.8, 8);
    expect(sameDay[paceBaselineKey("codex", "weekly")]).toEqual(baseline);
  });

  it("uses the latest Radar probability when the next local day begins", () => {
    const resetsAt = new Date("2026-07-27T00:00:00+08:00").toISOString();
    const first = refreshDailyPaceBaselines(
      {},
      [codexSnapshot(70, resetsAt)],
      new Date("2026-07-22T00:00:00+08:00"),
      new Set(),
      resetForecast(80),
    );
    const nextDay = refreshDailyPaceBaselines(
      first,
      [codexSnapshot(65, resetsAt)],
      new Date("2026-07-23T00:00:00+08:00"),
      new Set(),
      resetForecast(10),
    );
    const baseline = nextDay[paceBaselineKey("codex", "weekly")];

    expect(baseline.localDate).not.toBe(first[paceBaselineKey("codex", "weekly")].localDate);
    expect(baseline.resetForecastScore).toBe(10);
    // 10% × 24h + 90% × the remaining 96h = 88.8h.
    expect((Date.parse(baseline.planningResetsAt) - Date.parse(baseline.capturedAt)) / 3_600_000).toBeCloseTo(88.8, 8);
  });

  it("recalculates next day from leftover quota and the exact projected reset time", () => {
    const resetsAt = new Date("2026-07-25T12:00:00+08:00").toISOString();
    const firstDay = new Date("2026-07-22T08:00:00+08:00");
    const first = refreshDailyPaceBaselines({}, [codexSnapshot(70, resetsAt)], firstDay);
    const nextDay = new Date("2026-07-23T04:00:00+08:00");
    const next = refreshDailyPaceBaselines(first, [codexSnapshot(66, resetsAt)], nextDay);
    const baseline = next[paceBaselineKey("codex", "weekly")];
    const pace = calculateQuotaPace(codexSnapshot(66, resetsAt).weeklyWindow!, nextDay, baseline);

    expect(baseline.localDate).not.toBe(first[paceBaselineKey("codex", "weekly")].localDate);
    // By the end of the usage day, 78.57% may be used. Codex reports 34% used
    // since reset, so the conserved 44.57% remains available today.
    expect(pace.todayUsedPercent).toBe(34);
    expect(pace.todayRemainingPercent).toBeCloseTo(46.952380952, 8);
    expect(pace.averageRate).toBeCloseTo(28.285714286, 8);
  });

  it("preserves an early Codex reset anchor across local-day rebalancing", () => {
    const resetAt = new Date("2026-07-22T08:00:00+08:00");
    const resetsAt = new Date("2026-08-03T08:00:00+08:00").toISOString();
    const first = refreshDailyPaceBaselines(
      {},
      [codexSnapshot(100, resetsAt)],
      resetAt,
      new Set(["codex"]),
    );
    const nextDay = new Date("2026-07-23T04:00:00+08:00");
    const next = refreshDailyPaceBaselines(first, [codexSnapshot(95, resetsAt)], nextDay);
    const baseline = next[paceBaselineKey("codex", "weekly")];
    const pace = calculateQuotaPace(codexSnapshot(95, resetsAt).weeklyWindow!, nextDay, baseline);

    expect(baseline.cycleStartedAt).toBe(resetAt.toISOString());
    expect(baseline.cycleStartRemainingPercent).toBe(100);
    expect(pace.todayUsedPercent).toBe(5);
    expect(pace.recommendedUsedPercent).toBeGreaterThan(0);
  });

  it("starts a new daily pace baseline at 4:00", () => {
    const resetsAt = new Date("2026-07-27T04:00:00+08:00").toISOString();
    const beforeFour = refreshDailyPaceBaselines(
      {},
      [codexSnapshot(70, resetsAt)],
      new Date("2026-07-22T03:59:00+08:00"),
    );
    const atFour = refreshDailyPaceBaselines(
      beforeFour,
      [codexSnapshot(70, resetsAt)],
      new Date("2026-07-22T04:00:00+08:00"),
    );

    expect(atFour[paceBaselineKey("codex", "weekly")].localDate)
      .not.toBe(beforeFour[paceBaselineKey("codex", "weekly")].localDate);
  });

  it("reanchors immediately when the projected weekly reset timestamp changes", () => {
    const now = new Date("2026-07-22T08:00:00+08:00");
    const oldReset = new Date("2026-07-26T08:00:00+08:00").toISOString();
    const newReset = new Date("2026-07-25T08:00:00+08:00").toISOString();
    const oldBaselines = refreshDailyPaceBaselines({}, [codexSnapshot(70, oldReset)], now);
    const next = refreshDailyPaceBaselines(oldBaselines, [codexSnapshot(68, newReset)], new Date("2026-07-22T09:00:00+08:00"));
    const baseline = next[paceBaselineKey("codex", "weekly")];

    expect(baseline.resetsAt).toBe(newReset);
    expect(baseline.remainingPercent).toBe(68);
    expect(baseline.capturedAt).toBe(new Date("2026-07-22T09:00:00+08:00").toISOString());
  });

  it("preserves the daily baseline through a transient provider failure", () => {
    const now = new Date("2026-07-22T08:00:00+08:00");
    const resetsAt = new Date("2026-07-26T08:00:00+08:00").toISOString();
    const current = refreshDailyPaceBaselines({}, [codexSnapshot(70, resetsAt)], now);
    const unavailable = {
      ...codexSnapshot(0, resetsAt),
      weeklyWindow: null,
      status: "unavailable" as const,
    };

    expect(refreshDailyPaceBaselines(current, [unavailable], new Date("2026-07-22T09:00:00+08:00"))).toEqual(current);
    expect(refreshDailyPaceBaselines(current, [{ ...unavailable, status: "signed_out" }], new Date("2026-07-22T09:00:00+08:00"))).toEqual({});
  });

  it("tracks only the weekly Codex window even when compatibility data includes 5h", () => {
    const codex: ProviderSnapshot = {
      provider: "codex",
      displayName: "CODEX",
      plan: "PRO",
      shortWindow: { remainingPercent: 1, resetsAt: "2026-07-20T05:00:00Z", windowSeconds: 18_000 },
      weeklyWindow: { remainingPercent: 90, resetsAt: "2026-07-25T00:00:00Z", windowSeconds: 604_800 },
      resetCredits: 0,
      updatedAt: "2026-07-20T00:00:00Z",
      status: "ok",
      message: null,
    };
    expect(trackedQuotaWindows(codex).map((item) => item.period)).toEqual(["weekly"]);
    expect(mostOverPaceWindow(codex, new Date("2026-07-20T00:00:00Z"))).toBeNull();
  });
});

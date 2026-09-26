import { describe, expect, it } from "vitest";
import { activeResetWatch, RESET_WATCH_MAX_AGE_MS, resetWatchLabel } from "./resetWatch";
import type { ResetForecast, ResetWatch } from "../types";

const now = new Date("2026-09-09T06:00:00Z");
const watch: ResetWatch = {
  level: "strong", resetChancePercent: 70,
  observedAt: "2026-09-09T05:00:00Z", expiresAt: "2026-09-10T05:00:00Z",
};
const forecast: ResetForecast = {
  score: 2, windowHours: 24, fetchedAt: "2026-09-09T05:58:00Z",
  resetAnnounced: false, sourceUrl: "https://example.invalid/not-the-watch-link",
  activeWatch: watch, watchCheckedAt: now.toISOString(),
};

describe("active website Watch", () => {
  it("uses the upstream Watch, not a risk score or probability threshold", () => {
    expect(activeResetWatch(forecast, now)).toEqual(watch);
    expect(activeResetWatch({ ...forecast, score: 99, activeWatch: null }, now)).toBeNull();
    expect(activeResetWatch({ ...forecast, activeWatch: { ...watch, level: "elevated", resetChancePercent: 10 } }, now)).not.toBeNull();
    expect(activeResetWatch({ ...forecast, activeWatch: { ...watch, resetChancePercent: null } }, now)).not.toBeNull();
  });
  it("clears on null, old payloads, retraction, expiration or stale checks", () => {
    for (const candidate of [null, { ...forecast, activeWatch: undefined }, { ...forecast, watchCheckedAt: undefined }, { ...forecast, activeWatch: null }]) {
      expect(activeResetWatch(candidate, now)).toBeNull();
    }
    expect(activeResetWatch({ ...forecast, activeWatch: { ...watch, expiresAt: now.toISOString() } }, now)).toBeNull();
    expect(activeResetWatch(forecast, new Date(now.getTime() + RESET_WATCH_MAX_AGE_MS))).toBeNull();
    expect(activeResetWatch(forecast, new Date(now.getTime() + RESET_WATCH_MAX_AGE_MS - 1))).not.toBeNull();
  });
  it.each([
    { expiresAt: "bad" }, { observedAt: "bad" }, { observedAt: "2026-09-11T00:00:00Z" },
    { expiresAt: "2026-09-09T04:00:00Z" }, { level: "unknown" },
    { resetChancePercent: 101 }, { resetChancePercent: -1 }, { resetChancePercent: 1.5 },
  ])("fails closed for malformed Watch %j", (patch) => {
    expect(activeResetWatch({ ...forecast, activeWatch: { ...watch, ...patch } as ResetWatch }, now)).toBeNull();
  });
  it("rejects invalid/far-future checked time and labels the external prediction", () => {
    expect(activeResetWatch({ ...forecast, watchCheckedAt: "bad" }, now)).toBeNull();
    expect(activeResetWatch({ ...forecast, watchCheckedAt: "2026-09-11T00:00:00Z" }, now)).toBeNull();
    expect(resetWatchLabel(watch, "zh-CN")).toContain("第三方预测");
    expect(resetWatchLabel({ ...watch, resetChancePercent: null }, "en")).not.toContain("%");
  });
});

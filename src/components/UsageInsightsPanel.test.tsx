// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PersonalUsageCalibration } from "../lib/personalUsageModel";
import type { ProviderSnapshot } from "../types";
import { UsageInsightsPanel } from "./UsageInsightsPanel";

const snapshot: ProviderSnapshot = {
  provider: "codex",
  displayName: "CODEX",
  plan: "Pro",
  shortWindow: null,
  weeklyWindow: { remainingPercent: 55, resetsAt: "2026-08-30T00:00:00.000Z", windowSeconds: 604_800 },
  resetCredits: null,
  updatedAt: "2026-08-27T08:00:00.000Z",
  status: "ok",
  message: null,
};

const calibration: PersonalUsageCalibration = {
  mode: "generic-fallback",
  reason: "insufficient-calendar-span",
  policyVersion: "p014-t011-local-week-pattern-v1",
  calendarSpanDays: 11,
  plannedDays: 11,
  activeDays: 11,
  latestPlannedDate: "2026-08-26",
  latestActiveDate: "2026-08-26",
  weekdayStats: Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    plannedDays: weekday < 4 ? 2 : 1,
    rememberedDays: weekday < 4 ? 2 : 1,
    rememberRate: 1,
    meanUsedPercent: weekday >= 5 ? 2.5 : 20,
    meanUtilization: weekday >= 5 ? 0.12 : 1.1,
    overuseRate: weekday < 5 ? 0.5 : 0,
    meanOverusePercent: weekday < 5 ? 4 : 0,
    allocationWeight: weekday >= 5 ? 0.3 : 1.1,
  })),
  validation: null,
};

describe("usage insight personal model", () => {
  it("shows provisional weekday statistics while clearly retaining the generic fallback", () => {
    render(<UsageInsightsPanel
      snapshot={snapshot}
      history={[]}
      dailyUsage={[]}
      paceBaselines={{}}
      language="zh-CN"
      personalUsageCalibration={calibration}
    />);

    expect(screen.getByText("通用策略回退")).toBeTruthy();
    expect(screen.getByText(/不足 3 周/)).toBeTruthy();
    expect(screen.getByText(/11 个建议日/)).toBeTruthy();
    expect(screen.getByText(/至少需要 21 个建议日/)).toBeTruthy();
  });
});

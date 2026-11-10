import { describe, expect, it } from "vitest";
import { buildClaudeCockpitView, claudeDailyShare, claudeQuotaMessage, nextClaudeDayBaseline, nextCockpitMode, normalizeCockpitMode, recentClaudeCosts } from "./claudeCockpit";
import { normalizeWidgetPreferences } from "./preferences";
import type { ClaudeDailyUsage, ClaudeQuota, ClaudeUsageReport } from "../types";

// 2026-11-10 20:00 in Asia/Shanghai.
const now = new Date("2026-11-10T12:00:00Z");

function day(localDate: string, costUsd: number, models: ClaudeDailyUsage["models"] = []): ClaudeDailyUsage {
  return { localDate, requests: 1, inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1, costUsd, unpricedRequests: 0, models };
}

function report(days: ClaudeDailyUsage[]): ClaudeUsageReport {
  return {
    status: "ok",
    observedAt: now.toISOString(),
    latestActivityAt: null,
    priceCheckedAt: "2026-11-09",
    days,
    prices: [{ id: "claude-opus-5-5", name: "Opus 5.5", price: { input: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 } }],
  };
}

const quota = (overrides: Partial<ClaudeQuota> = {}): ClaudeQuota => ({
  status: "ok",
  fiveHour: { usedPercent: 38, resetsAt: "2026-11-10T14:30:00Z" },
  sevenDay: { usedPercent: 57.2, resetsAt: "2026-11-13T08:00:00Z" },
  sevenDayOpus: { usedPercent: 12, resetsAt: null },
  sevenDaySonnet: null,
  plan: "max",
  observedAt: now.toISOString(),
  message: null,
  ...overrides,
});

describe("cockpit mode", () => {
  it("cycles Codex, Claude and AI and keeps legacy preferences on Codex", () => {
    expect(nextCockpitMode("codex")).toBe("claude");
    expect(nextCockpitMode("claude")).toBe("ai");
    expect(nextCockpitMode("ai")).toBe("codex");
    expect(normalizeCockpitMode("gemini")).toBe("codex");
    expect(normalizeWidgetPreferences({ language: "en" }).cockpitMode).toBe("codex");
    expect(normalizeWidgetPreferences({ cockpitMode: "ai" }).cockpitMode).toBe("ai");
  });
});

describe("Claude quota view", () => {
  it("shows weekly and 5-hour remaining from the official limits", () => {
    const view = buildClaudeCockpitView(report([day("2026-11-10", 10)]), quota(), now);
    expect(view.weeklyRemaining).toBe(42.8);
    expect(view.fiveHourRemaining).toBe(62);
    expect(view.opusWeeklyRemaining).toBe(88);
    expect(view.weeklyResetsAt).toBe("2026-11-13T08:00:00Z");
    expect(view.dailyShare).toBe(14.3);
  });

  it("keeps the last good figures when stale and hides them when signed out", () => {
    expect(buildClaudeCockpitView(null, quota({ status: "stale", message: "Network unavailable." }), now).weeklyRemaining).toBe(42.8);
    const signedOut = buildClaudeCockpitView(null, quota({ status: "signed_out", message: "Claude Code login expired. Open Claude Code to refresh it." }), now);
    expect(signedOut.weeklyRemaining).toBeNull();
    expect(signedOut.fiveHourRemaining).toBeNull();
    expect(claudeQuotaMessage(signedOut, "zh-CN")).toBe("Claude Code 登录已过期");
    expect(claudeQuotaMessage(buildClaudeCockpitView(null, null, now), "zh-CN")).toBe("正在读取 Claude 额度");
  });

  it("splits the weekly remainder evenly over days left, never dividing by zero", () => {
    expect(claudeDailyShare(40, "2026-11-12T12:00:00Z", now)).toBe(20);
    expect(claudeDailyShare(40, "2026-11-10T13:00:00Z", now)).toBe(40);
    expect(claudeDailyShare(40, null, now)).toBeNull();
    expect(claudeDailyShare(null, "2026-11-12T12:00:00Z", now)).toBeNull();
  });

  it("lists 7-day models with prices and keeps unpriced models distinct", () => {
    const usage = report([
      day("2026-11-03", 50),
      day("2026-11-09", 14, [{ id: "claude-future", name: "claude-future", requests: 1, inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1, costUsd: null }]),
      day("2026-11-10", 10, [{ id: "claude-opus-5-5", name: "Opus 5.5", requests: 1, inputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 900, outputTokens: 0, costUsd: 10 }]),
    ]);
    expect(recentClaudeCosts(usage, now, 7).map((item) => item.costUsd)).toEqual([0, 0, 0, 0, 0, 14, 10]);
    const view = buildClaudeCockpitView(usage, quota(), now);
    expect(view.todayCostUsd).toBe(10);
    expect(view.weekCostUsd).toBe(24);
    expect(view.models.map((model) => [model.name, model.costUsd, model.price])).toEqual([
      ["claude-future", null, null],
      ["Opus 5.5", 10, { input: 4, output: 20 }],
    ]);
  });
});

describe("Claude without a 5-hour window", () => {
  it("measures today's use from the first weekly reading, like the Codex cockpit", () => {
    const noFiveHour = quota({ fiveHour: null, sevenDay: { usedPercent: 50, resetsAt: "2026-11-13T08:00:00Z" } });
    const morning = nextClaudeDayBaseline(null, { ...noFiveHour, sevenDay: { usedPercent: 40, resetsAt: "2026-11-13T08:00:00Z" } }, now);
    expect(morning).toEqual({ localDate: "2026-11-10", weeklyUsedPercent: 40 });
    expect(nextClaudeDayBaseline(morning, noFiveHour, now)).toBe(morning);
    const view = buildClaudeCockpitView(null, noFiveHour, now, morning);
    expect(view.fiveHourRemaining).toBeNull();
    expect(view.todayUsedPercent).toBe(10);
    expect(view.dailyShare).toBe(20);
    expect(view.todayRatio).toBe(50);
  });

  it("restarts the baseline on a new day or after a weekly reset", () => {
    const yesterday = { localDate: "2026-11-09", weeklyUsedPercent: 30 };
    expect(nextClaudeDayBaseline(yesterday, quota(), now)).toEqual({ localDate: "2026-11-10", weeklyUsedPercent: 57.2 });
    const reset = nextClaudeDayBaseline({ localDate: "2026-11-10", weeklyUsedPercent: 80 }, quota(), now);
    expect(reset?.weeklyUsedPercent).toBe(57.2);
    expect(nextClaudeDayBaseline(yesterday, quota({ status: "unavailable" }), now)).toBe(yesterday);
    expect(buildClaudeCockpitView(null, quota(), now, yesterday).todayRatio).toBeNull();
  });
});

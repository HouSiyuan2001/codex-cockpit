import { describe, expect, it } from "vitest";
import {
  buildClaudeCockpitView,
  claudeComfortPromptTarget,
  estimateClaudeComfortCap,
  nextCockpitMode,
  normalizeClaudeCap,
  normalizeClaudeComfortFeedback,
  normalizeCockpitMode,
  recentClaudeCosts,
  suggestedClaudeCap,
  upsertClaudeComfort,
} from "./claudeCockpit";
import { normalizeWidgetPreferences } from "./preferences";
import type { ClaudeComfortRecord, ClaudeDailyUsage, ClaudeUsageReport } from "../types";

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

const feedback = (localDate: string, comfort: ClaudeComfortRecord["comfort"], costUsd: number | null): ClaudeComfortRecord => ({ localDate, comfort, costUsd, observedAt: "" });

describe("cockpit mode", () => {
  it("cycles Codex, Claude and AI and keeps legacy preferences on Codex", () => {
    expect(nextCockpitMode("codex")).toBe("claude");
    expect(nextCockpitMode("claude")).toBe("ai");
    expect(nextCockpitMode("ai")).toBe("codex");
    expect(normalizeCockpitMode("gemini")).toBe("codex");
    const legacy = normalizeWidgetPreferences({ language: "en" });
    expect(legacy.cockpitMode).toBe("codex");
    expect(legacy.claudeDailyCapUsd).toBeNull();
    expect(legacy.claudeComfortFeedback).toEqual([]);
    expect(normalizeWidgetPreferences({ cockpitMode: "ai", claudeDailyCapUsd: 12.345 }).claudeDailyCapUsd).toBe(12.35);
  });

  it("rejects invalid caps and feedback, keeping the latest answer per day", () => {
    expect(normalizeClaudeCap(Number.NaN)).toBeNull();
    expect(normalizeClaudeCap(-1)).toBeNull();
    const records = normalizeClaudeComfortFeedback([
      feedback("2026-11-02", "idle", 3),
      { localDate: "bad", comfort: "idle", costUsd: 1 },
      { localDate: "2026-11-03", comfort: "tired", costUsd: 1 },
      feedback("2026-11-01", "overloaded", Number.POSITIVE_INFINITY),
      feedback("2026-11-02", "comfortable", 4),
    ]);
    expect(records.map((record) => [record.localDate, record.comfort, record.costUsd])).toEqual([
      ["2026-11-01", "overloaded", null],
      ["2026-11-02", "comfortable", 4],
    ]);
  });
});

describe("Claude comfort estimate", () => {
  it("needs three priced answers and moves below too-much days and above easy days", () => {
    expect(estimateClaudeComfortCap([feedback("2026-11-09", "comfortable", 20), feedback("2026-11-08", "comfortable", 20)], now)).toBeNull();
    const balanced = estimateClaudeComfortCap([
      feedback("2026-11-09", "comfortable", 20),
      feedback("2026-11-08", "comfortable", 20),
      feedback("2026-11-07", "comfortable", 20),
    ], now);
    expect(balanced?.capUsd).toBe(20);
    const heavy = estimateClaudeComfortCap([
      feedback("2026-11-09", "overloaded", 20),
      feedback("2026-11-08", "overloaded", 20),
      feedback("2026-11-07", "overloaded", 20),
    ], now);
    expect(heavy?.capUsd).toBe(16);
    const easy = estimateClaudeComfortCap([
      feedback("2026-11-09", "idle", 20),
      feedback("2026-11-08", "idle", 20),
      feedback("2026-11-07", "idle", 20),
    ], now);
    expect(easy?.capUsd).toBe(30);
  });

  it("weights recent feedback more strongly and ignores days without cost", () => {
    const estimate = estimateClaudeComfortCap([
      feedback("2026-09-01", "comfortable", 100),
      feedback("2026-11-09", "comfortable", 10),
      feedback("2026-11-08", "comfortable", 10),
      feedback("2026-11-07", "comfortable", null),
    ], now);
    expect(estimate?.samples).toBe(3);
    expect(estimate!.capUsd).toBeGreaterThan(10);
    expect(estimate!.capUsd).toBeLessThan(13);
  });

  it("falls back to the recent active-day average before enough feedback", () => {
    const usage = report([day("2026-11-08", 10), day("2026-11-09", 30), day("2026-11-10", 99)]);
    expect(suggestedClaudeCap(null, usage, now)).toBe(20);
    expect(suggestedClaudeCap(null, report([]), now)).toBe(20);
    expect(suggestedClaudeCap({ capUsd: 7.5, samples: 3 }, usage, now)).toBe(7.5);
  });
});

describe("Claude comfort prompt", () => {
  it("catches up yesterday before 22:00 and asks about today afterwards", () => {
    const usage = report([day("2026-11-09", 12), day("2026-11-10", 5)]);
    expect(claudeComfortPromptTarget(usage, [], now)).toEqual({ localDate: "2026-11-09", isCatchUp: true, costUsd: 12 });
    expect(claudeComfortPromptTarget(usage, [feedback("2026-11-09", "comfortable", 12)], now)).toBeNull();
    const late = new Date("2026-11-10T14:30:00Z");
    expect(claudeComfortPromptTarget(usage, [], late)).toEqual({ localDate: "2026-11-10", isCatchUp: false, costUsd: 5 });
  });

  it("does not ask about days without Claude use", () => {
    expect(claudeComfortPromptTarget(report([day("2026-11-10", 5)]), [], now)).toBeNull();
    expect(claudeComfortPromptTarget(null, [], now)).toBeNull();
  });

  it("replaces an answer for the same day", () => {
    const records = upsertClaudeComfort([feedback("2026-11-09", "idle", 1)], feedback("2026-11-09", "overloaded", 2));
    expect(records).toEqual([feedback("2026-11-09", "overloaded", 2)]);
  });
});

describe("Claude cockpit view", () => {
  it("fills zero days, divides by the personal cap and keeps unpriced models distinct", () => {
    const usage = report([
      day("2026-11-03", 50),
      day("2026-11-09", 14, [{ id: "claude-future", name: "claude-future", requests: 1, inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1, costUsd: null }]),
      day("2026-11-10", 10, [{ id: "claude-opus-5-5", name: "Opus 5.5", requests: 1, inputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 900, outputTokens: 0, costUsd: 10 }]),
    ]);
    expect(recentClaudeCosts(usage, now, 7).map((item) => item.costUsd)).toEqual([0, 0, 0, 0, 0, 14, 10]);
    const view = buildClaudeCockpitView(usage, { claudeDailyCapUsd: 20, claudeComfortFeedback: [] }, now);
    expect(view.todayCostUsd).toBe(10);
    expect(view.weekCostUsd).toBe(24);
    expect(view.todayRatio).toBe(50);
    expect(view.weekRatio).toBe(17.1);
    expect(view.manualCap).toBe(true);
    expect(view.models.map((model) => [model.name, model.costUsd, model.price])).toEqual([
      ["claude-future", null, null],
      ["Opus 5.5", 10, { input: 4, output: 20 }],
    ]);
  });

  it("reports no ratios when Claude data is unavailable", () => {
    const view = buildClaudeCockpitView({ ...report([]), status: "unavailable" }, { claudeDailyCapUsd: null, claudeComfortFeedback: [] }, now);
    expect(view.available).toBe(false);
    expect(view.todayRatio).toBeNull();
    expect(view.capUsd).toBe(20);
  });
});

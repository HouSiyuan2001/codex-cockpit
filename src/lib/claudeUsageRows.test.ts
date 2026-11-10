import { describe, expect, it } from "vitest";
import { addClaudeMetrics, aggregateClaudeRows, claudeTaskAsCodexTask, claudeTaskName } from "./claudeUsageRows";
import type { ClaudeDailyUsage, ClaudeModelUsage, ClaudeUsageReport } from "../types";

const now = new Date("2026-11-10T12:00:00Z");
const row = (id: string, name: string, costUsd: number | null, detail?: string): ClaudeModelUsage => ({ id, name, requests: 1, inputTokens: 10, cacheWriteTokens: 5, cacheReadTokens: 100, outputTokens: 20, costUsd, detail });
const day = (localDate: string, rows: ClaudeModelUsage[]): ClaudeDailyUsage => ({
  localDate, requests: rows.length, inputTokens: 10 * rows.length, cacheWriteTokens: 5 * rows.length, cacheReadTokens: 100 * rows.length, outputTokens: 20 * rows.length,
  costUsd: rows.reduce((sum, item) => sum + (item.costUsd ?? 0), 0), unpricedRequests: rows.filter((item) => item.costUsd === null).length,
  models: rows, tasks: rows, projects: rows,
});
const report: ClaudeUsageReport = {
  status: "ok", observedAt: now.toISOString(), latestActivityAt: null, priceCheckedAt: "2026-11-09", prices: [],
  days: [day("2026-11-01", [row("s0", "Old", 3)]), day("2026-11-09", [row("s1", "Review", 2, "Rcusp")]), day("2026-11-10", [row("s1", "Review", 1, "Rcusp"), row("s2abcdef99", "", null, "alpha")])],
};

describe("Claude usage rows", () => {
  it("limits rows to the selected period and merges a session across days", () => {
    const today = aggregateClaudeRows(report, "today", "tasks", now);
    expect(today.rows.map((item) => item.id).sort()).toEqual(["s1", "s2abcdef99"]);
    const week = aggregateClaudeRows(report, "7d", "tasks", now);
    const review = week.rows.find((item) => item.id === "s1")!;
    expect(review.estimatedCostUsd).toBe(3);
    expect(review.totalTokens).toBe(270);
    expect(review.inputTokens).toBe(30);
    expect(review.cachedInputTokens).toBe(200);
    expect(week.details.s1).toBe("Rcusp · s1");
    expect(aggregateClaudeRows(report, "all", "tasks", now).rows).toHaveLength(3);
  });

  it("keeps unpriced rows unknown and names untitled sessions", () => {
    const today = aggregateClaudeRows(report, "today", "models", now);
    const unpriced = today.rows.find((item) => item.id === "s2abcdef99")!;
    expect(unpriced.costIncomplete).toBe(true);
    expect(today.summary.costIncomplete).toBe(true);
    expect(today.summary.estimatedCostUsd).toBe(1);
    expect(claudeTaskName({ id: "s2abcdef99", name: " " })).toBe("Claude s2abcdef");
  });
});

describe("AI usage merge", () => {
  it("honours a calendar range and shapes Claude sessions as Codex task rows", () => {
    const ranged = aggregateClaudeRows(report, "all", "tasks", now, { start: "2026-11-09", end: "2026-11-09" });
    expect(ranged.rows.map((item) => item.id)).toEqual(["s1"]);
    const task = claudeTaskAsCodexTask(ranged.rows[0], ranged.projects.s1);
    expect(task.id).toBe("claude:s1");
    expect(task.projectName).toBe("Claude · Rcusp");
    expect(task.relation).toBe("root");
    expect(task.children).toEqual([]);
    expect(task.estimatedCostUsd).toBe(2);
  });

  it("adds totals and keeps an unknown cost unknown", () => {
    const base = { inputTokens: 1, cachedInputTokens: 2, outputTokens: 3, reasoningTokens: 0, totalTokens: 6, estimatedCostUsd: 1 };
    const claude = { inputTokens: 10, cachedInputTokens: 20, outputTokens: 30, reasoningTokens: 0, totalTokens: 60, estimatedCostUsd: 2 };
    expect(addClaudeMetrics(base, claude)).toMatchObject({ totalTokens: 66, estimatedCostUsd: 3, cachedInputTokens: 22 });
    expect(addClaudeMetrics({ ...base, estimatedCostUsd: null }, claude).estimatedCostUsd).toBeNull();
    expect(addClaudeMetrics(base, null)).toBe(base);
  });
});

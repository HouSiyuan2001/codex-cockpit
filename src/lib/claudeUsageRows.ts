import type { AggregatedTaskUsage, ModelUsage, UsageMetrics, UsagePeriod } from "./tokeiUsage";
import { dateAtBeijingNoon, localDateKey } from "./usageDay";
import type { ClaudeModelUsage, ClaudeUsageReport } from "../types";

export type ClaudeUsageView = "tasks" | "projects" | "models";

const PERIOD_DAYS: Partial<Record<UsagePeriod, number>> = { today: 1, "7d": 7, "30d": 30 };

function firstDate(period: UsagePeriod, now: Date): string | null {
  const days = PERIOD_DAYS[period];
  if (!days) return null;
  const start = dateAtBeijingNoon(localDateKey(now));
  start.setUTCDate(start.getUTCDate() - days + 1);
  return localDateKey(start);
}

function emptyUsage(id: string, name: string): ModelUsage {
  return { id, name, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, estimatedCostUsd: 0 };
}

/** Claude splits input into uncached, cache-write and cache-read; the shared layout shows cache reads as cached input. */
function add(target: ModelUsage, source: ClaudeModelUsage | Omit<ClaudeModelUsage, "id" | "name" | "detail">): void {
  target.inputTokens += source.inputTokens + source.cacheWriteTokens;
  target.cachedInputTokens += source.cacheReadTokens;
  target.outputTokens += source.outputTokens;
  target.totalTokens += source.inputTokens + source.cacheWriteTokens + source.cacheReadTokens + source.outputTokens;
  if (source.costUsd === null || target.estimatedCostUsd === null) {
    target.costIncomplete = true;
    target.estimatedCostUsd = source.costUsd === null ? target.estimatedCostUsd : (target.estimatedCostUsd ?? 0) + source.costUsd;
  } else target.estimatedCostUsd += source.costUsd;
}

export function claudeTaskName(row: Pick<ClaudeModelUsage, "id" | "name">): string {
  return row.name.trim() || `Claude ${row.id.slice(0, 8)}`;
}

export function aggregateClaudeRows(report: ClaudeUsageReport, period: UsagePeriod, view: ClaudeUsageView, now = new Date(), range: { start: string; end: string } | null = null): { summary: ModelUsage; rows: ModelUsage[]; details: Record<string, string>; projects: Record<string, string> } {
  const start = range?.start ?? firstDate(period, now);
  const end = range?.end ?? localDateKey(now);
  const summary = emptyUsage("claude", "Claude");
  const rows = new Map<string, ModelUsage>();
  const details: Record<string, string> = {};
  const projects: Record<string, string> = {};
  for (const day of report.days) {
    if ((start && day.localDate < start) || day.localDate > end) continue;
    // Day totals carry the known cost; unpriced requests only mark it incomplete.
    add(summary, { requests: day.requests, inputTokens: day.inputTokens, cacheWriteTokens: day.cacheWriteTokens, cacheReadTokens: day.cacheReadTokens, outputTokens: day.outputTokens, costUsd: day.costUsd });
    if (day.unpricedRequests > 0) summary.costIncomplete = true;
    const source = view === "tasks" ? day.tasks ?? [] : view === "projects" ? day.projects ?? [] : day.models;
    for (const item of source) {
      const row = rows.get(item.id) ?? emptyUsage(item.id, view === "tasks" ? claudeTaskName(item) : item.name);
      add(row, item);
      rows.set(item.id, row);
      if (view === "tasks") {
        details[item.id] = [item.detail, item.id.slice(0, 8)].filter(Boolean).join(" · ");
        if (item.detail) projects[item.id] = item.detail;
      }
    }
  }
  return { summary, rows: [...rows.values()], details, projects };
}

/** A Claude session shaped like a Codex task row, so both rank in one list. */
export function claudeTaskAsCodexTask(row: ModelUsage, projectName: string | undefined): AggregatedTaskUsage {
  const id = `claude:${row.id}`;
  const detail = { ...row, id, knownCostUsd: row.estimatedCostUsd, relation: "root" as const, models: [] };
  return { ...row, id, rawName: row.name, knownCostUsd: row.estimatedCostUsd, projectName: ["Claude", projectName].filter(Boolean).join(" · "), relation: "root", self: detail, children: [] };
}

/** Adds Claude's metrics to a Codex total; an unknown cost on either side stays unknown. */
export function addClaudeMetrics<T extends UsageMetrics>(base: T, claude: UsageMetrics | null): T {
  if (!claude) return base;
  return {
    ...base,
    inputTokens: base.inputTokens + claude.inputTokens,
    cachedInputTokens: base.cachedInputTokens + claude.cachedInputTokens,
    outputTokens: base.outputTokens + claude.outputTokens,
    totalTokens: base.totalTokens + claude.totalTokens,
    estimatedCostUsd: base.estimatedCostUsd === null || claude.estimatedCostUsd === null ? null : base.estimatedCostUsd + claude.estimatedCostUsd,
  };
}

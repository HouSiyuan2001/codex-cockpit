import { periodStart, type AggregatedTaskUsage, type DailyModelUsage, type ModelUsage, type TokeiDevice, type UsageMetrics, type UsagePeriod } from "./tokeiUsage";
import { localDateKey } from "./usageDay";
import type { ClaudeDailyUsage, ClaudeModelUsage, ClaudeUsageReport } from "../types";

export type ClaudeUsageView = "tasks" | "projects" | "models";

function emptyUsage(id: string, name: string): ModelUsage {
  return { id, name, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, estimatedCostUsd: null };
}

/** Claude splits input into uncached, cache-write and cache-read; the shared layout shows cache reads as cached input. */
function add(target: ModelUsage, source: ClaudeModelUsage | ClaudeDailyUsage, costUsd = source.costUsd): void {
  target.inputTokens += source.inputTokens + source.cacheWriteTokens;
  target.cachedInputTokens += source.cacheReadTokens;
  target.outputTokens += source.outputTokens;
  target.totalTokens += source.inputTokens + source.cacheWriteTokens + source.cacheReadTokens + source.outputTokens;
  if (costUsd === null) target.costIncomplete = true;
  else target.estimatedCostUsd = (target.estimatedCostUsd ?? 0) + costUsd;
}

function addDay(target: ModelUsage, day: ClaudeDailyUsage): void {
  const unpriced = day.unpricedRequests > 0;
  add(target, day, unpriced && day.unpricedRequests >= day.requests ? null : day.costUsd);
  if (unpriced) target.costIncomplete = true;
}

export function claudeUsageDevice(report: ClaudeUsageReport, stale = false): TokeiDevice {
  const daily: Record<string, DailyModelUsage> = {};
  for (const day of report.days) {
    const total = emptyUsage("claude", "Claude");
    addDay(total, day);
    const models = day.models.map(model => {
      const usage = emptyUsage(model.id, model.name);
      add(usage, model);
      return usage;
    });
    daily[day.localDate] = { ...total, models };
  }
  return { id: "claude-local", updatedAt: report.observedAt, stale, daily, ranges: {} };
}

export function claudeTaskName(row: Pick<ClaudeModelUsage, "id" | "name">): string {
  return row.name.trim() || `Claude ${row.id.slice(0, 8)}`;
}

export function aggregateClaudeRows(report: ClaudeUsageReport, period: UsagePeriod, view: ClaudeUsageView, now = new Date(), range: { start: string; end: string } | null = null): { summary: ModelUsage; rows: ModelUsage[]; details: Record<string, string>; projects: Record<string, string> } {
  const today = localDateKey(now);
  const start = range?.start ?? periodStart(period, now);
  const end = range && range.end < today ? range.end : today;
  const summary = emptyUsage("claude", "Claude");
  const rows = new Map<string, ModelUsage>();
  const details: Record<string, string> = {};
  const projects: Record<string, string> = {};
  for (const day of report.days) {
    if (day.localDate < start || day.localDate > end) continue;
    addDay(summary, day);
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
  if (!claude || (claude.totalTokens === 0 && claude.estimatedCostUsd === null)) return base;
  return {
    ...base,
    inputTokens: base.inputTokens + claude.inputTokens,
    cachedInputTokens: base.cachedInputTokens + claude.cachedInputTokens,
    outputTokens: base.outputTokens + claude.outputTokens,
    totalTokens: base.totalTokens + claude.totalTokens,
    estimatedCostUsd: base.estimatedCostUsd === null || claude.estimatedCostUsd === null ? null : base.estimatedCostUsd + claude.estimatedCostUsd,
  };
}

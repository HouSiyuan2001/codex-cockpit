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

export function claudeUsageDevice(report: ClaudeUsageReport, stale = false, provider: "claude" | "gemini" = "claude"): TokeiDevice {
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
  return { id: `${provider}-local`, updatedAt: report.observedAt, stale, daily, ranges: {} };
}

export function aggregateClaudeRows(report: ClaudeUsageReport, period: UsagePeriod, view: ClaudeUsageView, now = new Date(), range: { start: string; end: string } | null = null, untitledTaskName = "Untitled task"): { summary: ModelUsage; rows: ModelUsage[]; details: Record<string, string>; projects: Record<string, string> } {
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
      const row = rows.get(item.id) ?? emptyUsage(item.id, view === "tasks" ? (item.name.trim() || untitledTaskName) : item.name);
      add(row, item);
      rows.set(item.id, row);
      if (view === "tasks") {
        if (item.detail) {
          details[item.id] = item.detail;
          projects[item.id] = item.detail;
        }
      }
    }
  }
  return { summary, rows: [...rows.values()], details, projects };
}

/** A Claude session shaped like a Codex task row, so both rank in one list. */
export function claudeTaskAsCodexTask(row: ModelUsage, projectName: string | undefined, provider: "claude" | "gemini" = "claude"): AggregatedTaskUsage {
  const id = `${provider}:${row.id}`;
  const detail = { ...row, id, knownCostUsd: row.estimatedCostUsd, relation: "root" as const, models: [] };
  return { ...row, id, rawName: row.name, knownCostUsd: row.estimatedCostUsd, projectName, sourceProvider: provider === "gemini" ? "Gemini" : "Claude", relation: "root", self: detail, children: [] };
}

/** Adds local provider metrics to a Codex total; unknown costs stay unknown. */
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

type ProviderUsageProjection = Pick<ClaudeUsageReport, "observedAt" | "latestActivityAt" | "days">;
export interface SharedProviderUsage {
  deviceId: string;
  deviceName: string;
  usage: Partial<Record<"claude" | "gemini", ProviderUsageProjection>>;
}

export function combineProviderUsage(local: ClaudeUsageReport | null, peers: ProviderUsageProjection[]): ClaudeUsageReport | null {
  if (!peers.length) return local;
  const reports = local?.status === "ok" ? [local, ...peers] : peers;
  const days = new Map<string, ClaudeDailyUsage>();
  for (const report of reports) {
    for (const day of report.days) {
      const first = days.get(day.localDate);
      days.set(day.localDate, first ? {
        ...first,
        requests: first.requests + day.requests,
        inputTokens: first.inputTokens + day.inputTokens,
        cacheWriteTokens: first.cacheWriteTokens + day.cacheWriteTokens,
        cacheReadTokens: first.cacheReadTokens + day.cacheReadTokens,
        outputTokens: first.outputTokens + day.outputTokens,
        costUsd: first.costUsd + day.costUsd,
        unpricedRequests: first.unpricedRequests + day.unpricedRequests,
        models: [...first.models, ...day.models],
      } : day);
    }
  }
  return {
    status: "ok",
    observedAt: reports.map(report => report.observedAt).sort().at(-1) ?? "",
    latestActivityAt: reports.flatMap(report => report.latestActivityAt ?? []).sort().at(-1) ?? null,
    priceCheckedAt: local?.priceCheckedAt ?? "",
    prices: local?.prices ?? [],
    days: [...days.values()].sort((a, b) => a.localDate.localeCompare(b.localDate)),
  };
}

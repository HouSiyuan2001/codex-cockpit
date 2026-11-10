import { COMFORT_FEEDBACK_HALF_LIFE_DAYS, COMFORT_REMINDER_HOUR } from "./comfortFeedback";
import { beijingParts, dateAtBeijingNoon, localDateKey } from "./usageDay";
import type { ClaudeComfortRecord, ClaudeDailyUsage, ClaudeUsageReport, CockpitMode, ComfortCode, Language } from "../types";

export const COCKPIT_MODES: readonly CockpitMode[] = ["codex", "claude", "ai"];
export const MAX_CLAUDE_COMFORT_RECORDS = 120;
/** Minimum feedback days before the comfort estimate replaces the usage fallback. */
export const CLAUDE_COMFORT_MIN_SAMPLES = 3;
export const CLAUDE_DEFAULT_CAP_USD = 20;
export const CLAUDE_CAP_SLIDER_MAX_USD = 200;

/**
 * Each answer implies where the comfortable daily amount lies relative to that
 * day's cost: "just right" is the cap itself, "too much" places it below and
 * "easy" above. These ratios are a personal heuristic, not an Anthropic limit.
 */
const IMPLIED_CAP_RATIO: Record<ComfortCode, number> = { comfortable: 1, overloaded: 1 / 1.25, idle: 1.5 };

export function normalizeCockpitMode(value: unknown): CockpitMode {
  return value === "claude" || value === "ai" ? value : "codex";
}

export function nextCockpitMode(mode: CockpitMode): CockpitMode {
  return COCKPIT_MODES[(COCKPIT_MODES.indexOf(mode) + 1) % COCKPIT_MODES.length];
}

export function normalizeClaudeCap(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(Math.min(10_000, Math.max(0.1, value)) * 100) / 100;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function normalizeClaudeComfortFeedback(value: unknown): ClaudeComfortRecord[] {
  if (!Array.isArray(value)) return [];
  const byDate = new Map<string, ClaudeComfortRecord>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (!validDate(record.localDate)) continue;
    if (record.comfort !== "overloaded" && record.comfort !== "comfortable" && record.comfort !== "idle") continue;
    const cost = typeof record.costUsd === "number" && Number.isFinite(record.costUsd) && record.costUsd >= 0 ? record.costUsd : null;
    byDate.delete(record.localDate);
    byDate.set(record.localDate, {
      localDate: record.localDate,
      comfort: record.comfort,
      costUsd: cost,
      observedAt: typeof record.observedAt === "string" ? record.observedAt.slice(0, 64) : "",
    });
  }
  return [...byDate.values()]
    .sort((left, right) => left.localDate.localeCompare(right.localDate))
    .slice(-MAX_CLAUDE_COMFORT_RECORDS);
}

function shiftDate(key: string, days: number): string {
  const date = dateAtBeijingNoon(key);
  date.setUTCDate(date.getUTCDate() + days);
  return localDateKey(date);
}

export function claudeDay(report: ClaudeUsageReport | null, localDate: string): ClaudeDailyUsage | null {
  return report?.days.find((day) => day.localDate === localDate) ?? null;
}

export function claudeDayCost(report: ClaudeUsageReport | null, localDate: string): number {
  return claudeDay(report, localDate)?.costUsd ?? 0;
}

/** Last `days` calendar days ending today, oldest first, with explicit zero days. */
export function recentClaudeCosts(report: ClaudeUsageReport | null, now: Date, days: number): Array<{ localDate: string; costUsd: number }> {
  const today = localDateKey(now);
  return Array.from({ length: days }, (_, index) => {
    const localDate = shiftDate(today, index - days + 1);
    return { localDate, costUsd: claudeDayCost(report, localDate) };
  });
}

export interface ClaudeComfortEstimate {
  capUsd: number;
  samples: number;
}

export function estimateClaudeComfortCap(records: readonly ClaudeComfortRecord[], now = new Date()): ClaudeComfortEstimate | null {
  const today = dateAtBeijingNoon(localDateKey(now)).getTime();
  let weightSum = 0;
  let logSum = 0;
  let samples = 0;
  for (const record of records) {
    if (record.costUsd === null || record.costUsd <= 0) continue;
    const ageDays = Math.max(0, (today - dateAtBeijingNoon(record.localDate).getTime()) / 86_400_000);
    const weight = 0.5 ** (ageDays / COMFORT_FEEDBACK_HALF_LIFE_DAYS);
    logSum += weight * Math.log(record.costUsd * IMPLIED_CAP_RATIO[record.comfort]);
    weightSum += weight;
    samples += 1;
  }
  if (samples < CLAUDE_COMFORT_MIN_SAMPLES || weightSum <= 0) return null;
  return { capUsd: Math.round(Math.exp(logSum / weightSum) * 10) / 10, samples };
}

/** Before enough feedback exists, start from the recent active-day average. */
export function suggestedClaudeCap(estimate: ClaudeComfortEstimate | null, report: ClaudeUsageReport | null, now = new Date()): number {
  if (estimate) return estimate.capUsd;
  const active = recentClaudeCosts(report, now, 15).slice(0, -1).filter((day) => day.costUsd > 0);
  if (active.length === 0) return CLAUDE_DEFAULT_CAP_USD;
  return Math.max(1, Math.round(active.reduce((sum, day) => sum + day.costUsd, 0) / active.length));
}

export function effectiveClaudeCap(manualCapUsd: number | null, suggestedCapUsd: number): number {
  return manualCapUsd ?? suggestedCapUsd;
}

export function usageRatioPercent(used: number, cap: number): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) return null;
  return Math.round((used / cap) * 1000) / 10;
}

export interface ClaudeComfortPromptTarget {
  localDate: string;
  isCatchUp: boolean;
  costUsd: number;
}

/** Ask about today after the reminder hour, otherwise catch up yesterday; skip days without use. */
export function claudeComfortPromptTarget(
  report: ClaudeUsageReport | null,
  records: readonly ClaudeComfortRecord[],
  now = new Date(),
  reminderHour = COMFORT_REMINDER_HOUR,
): ClaudeComfortPromptTarget | null {
  if (!report || report.status !== "ok") return null;
  const today = localDateKey(now);
  const localDate = beijingParts(now).hour >= reminderHour ? today : shiftDate(today, -1);
  if (records.some((record) => record.localDate === localDate)) return null;
  const costUsd = claudeDayCost(report, localDate);
  if (costUsd <= 0) return null;
  return { localDate, isCatchUp: localDate !== today, costUsd };
}

export function upsertClaudeComfort(records: readonly ClaudeComfortRecord[], record: ClaudeComfortRecord): ClaudeComfortRecord[] {
  return normalizeClaudeComfortFeedback([...records.filter((item) => item.localDate !== record.localDate), record]);
}

export function formatUsd(value: number | null, language: Language, compact = false): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const digits = compact && Math.abs(value) >= 100 ? 0 : value < 10 ? 2 : 1;
  return `$${new Intl.NumberFormat(language === "en" ? "en-US" : "zh-CN", { minimumFractionDigits: compact ? 0 : digits, maximumFractionDigits: digits }).format(value)}`;
}

export function formatTokens(value: number, language: Language): string {
  return new Intl.NumberFormat(language === "en" ? "en-US" : "zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatPerMillion(value: number): string {
  return `$${Number.isInteger(value) ? value : Number(value.toFixed(3))}`;
}

export interface ClaudeModelSummary {
  id: string;
  name: string;
  costUsd: number | null;
  tokens: number;
  price: { input: number; output: number } | null;
}

export interface ClaudeCockpitView {
  available: boolean;
  todayCostUsd: number;
  weekCostUsd: number;
  weekAverageUsd: number;
  capUsd: number;
  suggestedCapUsd: number;
  estimate: ClaudeComfortEstimate | null;
  manualCap: boolean;
  todayRatio: number | null;
  weekRatio: number | null;
  models: ClaudeModelSummary[];
  prompt: ClaudeComfortPromptTarget | null;
}

export function buildClaudeCockpitView(
  report: ClaudeUsageReport | null,
  preferences: { claudeDailyCapUsd: number | null; claudeComfortFeedback: readonly ClaudeComfortRecord[] },
  now = new Date(),
): ClaudeCockpitView {
  const week = recentClaudeCosts(report, now, 7);
  const weekCostUsd = week.reduce((sum, day) => sum + day.costUsd, 0);
  const todayCostUsd = week[week.length - 1]?.costUsd ?? 0;
  const estimate = estimateClaudeComfortCap(preferences.claudeComfortFeedback, now);
  const suggestedCapUsd = suggestedClaudeCap(estimate, report, now);
  const capUsd = effectiveClaudeCap(preferences.claudeDailyCapUsd, suggestedCapUsd);
  const weekDates = new Set(week.map((day) => day.localDate));
  const byModel = new Map<string, ClaudeModelSummary>();
  for (const day of report?.days ?? []) {
    if (!weekDates.has(day.localDate)) continue;
    for (const model of day.models) {
      const current = byModel.get(model.id) ?? {
        id: model.id,
        name: model.name,
        costUsd: 0,
        tokens: 0,
        price: (() => {
          const listed = report?.prices.find((item) => item.id === model.id)?.price;
          return listed ? { input: listed.input, output: listed.output } : null;
        })(),
      };
      current.tokens += model.inputTokens + model.cacheWriteTokens + model.cacheReadTokens + model.outputTokens;
      current.costUsd = current.costUsd === null || model.costUsd === null ? null : current.costUsd + model.costUsd;
      byModel.set(model.id, current);
    }
  }
  return {
    available: report?.status === "ok",
    todayCostUsd,
    weekCostUsd,
    weekAverageUsd: weekCostUsd / 7,
    capUsd,
    suggestedCapUsd,
    estimate,
    manualCap: preferences.claudeDailyCapUsd !== null,
    todayRatio: report?.status === "ok" ? usageRatioPercent(todayCostUsd, capUsd) : null,
    weekRatio: report?.status === "ok" ? usageRatioPercent(weekCostUsd, capUsd * 7) : null,
    models: [...byModel.values()].sort((left, right) => (right.costUsd ?? Infinity) - (left.costUsd ?? Infinity)),
    prompt: claudeComfortPromptTarget(report, preferences.claudeComfortFeedback, now),
  };
}

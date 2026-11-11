import { localDateKey } from "./usageDay";
import type { ClaudeQuota, ClaudeQuotaWindow, ClaudeUsageReport, CockpitMode, Language } from "../types";

export const COCKPIT_MODES: readonly CockpitMode[] = ["codex", "claude", "ai"];

export function normalizeCockpitMode(value: unknown): CockpitMode {
  return value === "claude" || value === "ai" ? value : "codex";
}

export function nextCockpitMode(mode: CockpitMode): CockpitMode {
  return COCKPIT_MODES[(COCKPIT_MODES.indexOf(mode) + 1) % COCKPIT_MODES.length];
}

function remaining(window: ClaudeQuotaWindow | null | undefined): number | null {
  if (!window || !Number.isFinite(window.usedPercent)) return null;
  return Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)) * 10) / 10;
}

/** Even share of the weekly remainder over the days left before the weekly reset. */
export function claudeDailyShare(weeklyRemaining: number | null, weeklyResetsAt: string | null, now = new Date()): number | null {
  if (weeklyRemaining === null) return null;
  const resetAt = weeklyResetsAt ? Date.parse(weeklyResetsAt) : Number.NaN;
  if (!Number.isFinite(resetAt)) return null;
  const days = Math.max(1, Math.ceil((resetAt - now.getTime()) / 86_400_000));
  return Math.round((weeklyRemaining / days) * 10) / 10;
}

/** First weekly reading of the calendar day; today's use is measured from it. */
export interface ClaudeDayBaseline {
  localDate: string;
  weeklyUsedPercent: number;
}

/** Starts a new baseline each day, and again when the weekly window resets mid-day. */
export function nextClaudeDayBaseline(previous: ClaudeDayBaseline | null, quota: ClaudeQuota | null, now = new Date()): ClaudeDayBaseline | null {
  const used = quota?.status === "ok" ? quota.sevenDay?.usedPercent : undefined;
  if (used === undefined || !Number.isFinite(used)) return previous;
  const localDate = localDateKey(now);
  if (!previous || previous.localDate !== localDate || used < previous.weeklyUsedPercent) return { localDate, weeklyUsedPercent: used };
  return previous;
}

export interface ClaudeCockpitView {
  quotaStatus: ClaudeQuota["status"];
  quotaMessage: string | null;
  plan: string | null;
  weeklyRemaining: number | null;
  weeklyResetsAt: string | null;
  fiveHourUsed: number | null;
  fiveHourResetsAt: string | null;
  opusWeeklyRemaining: number | null;
  dailyShare: number | null;
  /** Weekly percent used since the first reading today. */
  todayUsedPercent: number | null;
  /** Today's use relative to today's share, as the Codex cockpit shows without a 5-hour window. */
  todayRatio: number | null;
  usageAvailable: boolean;
  todayCostUsd: number;
}

export function buildClaudeCockpitView(report: ClaudeUsageReport | null, quota: ClaudeQuota | null, now = new Date(), baseline: ClaudeDayBaseline | null = null): ClaudeCockpitView {
  const today = localDateKey(now);
  const quotaReadable = quota?.status === "ok" || quota?.status === "stale";
  const fiveHourUsedPercent = quotaReadable ? quota?.fiveHour?.usedPercent : undefined;
  const weeklyRemaining = quotaReadable ? remaining(quota?.sevenDay) : null;
  const weeklyResetsAt = quotaReadable ? quota?.sevenDay?.resetsAt ?? null : null;
  const todayBaseline = baseline && baseline.localDate === today ? baseline : null;
  const weeklyUsed = quotaReadable ? quota?.sevenDay?.usedPercent ?? null : null;
  const todayUsedPercent = todayBaseline && weeklyUsed !== null
    ? Math.round(Math.max(0, weeklyUsed - todayBaseline.weeklyUsedPercent) * 10) / 10
    : null;
  // Fix today's share at the day-start remainder so it does not shrink while you work.
  const dayShare = todayBaseline ? claudeDailyShare(Math.max(0, 100 - todayBaseline.weeklyUsedPercent), weeklyResetsAt, now) : null;
  const todayRatio = todayUsedPercent !== null && dayShare !== null && dayShare > 0
    ? Math.round((todayUsedPercent / dayShare) * 1000) / 10
    : null;
  return {
    quotaStatus: quota?.status ?? "loading",
    quotaMessage: quota?.message ?? null,
    plan: quota?.plan ?? null,
    weeklyRemaining,
    weeklyResetsAt,
    fiveHourUsed: fiveHourUsedPercent !== undefined && Number.isFinite(fiveHourUsedPercent)
      ? Math.round(Math.max(0, Math.min(100, fiveHourUsedPercent)) * 10) / 10
      : null,
    fiveHourResetsAt: quotaReadable ? quota?.fiveHour?.resetsAt ?? null : null,
    opusWeeklyRemaining: quotaReadable ? remaining(quota?.sevenDayOpus) : null,
    dailyShare: dayShare ?? claudeDailyShare(weeklyRemaining, weeklyResetsAt, now),
    todayUsedPercent,
    todayRatio,
    usageAvailable: report?.status === "ok",
    todayCostUsd: report?.days.find((day) => day.localDate === today)?.costUsd ?? 0,
  };
}

export function formatUsd(value: number | null, language: Language, compact = false): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const digits = compact && Math.abs(value) >= 100 ? 0 : value < 10 ? 2 : 1;
  return `$${new Intl.NumberFormat(language === "en" ? "en-US" : "zh-CN", { minimumFractionDigits: compact ? 0 : digits, maximumFractionDigits: digits }).format(value)}`;
}

export function claudeQuotaMessage(view: ClaudeCockpitView, language: Language): string {
  if (view.quotaStatus === "loading") return language === "en" ? "Reading Claude quota" : "正在读取 Claude 额度";
  if (view.quotaStatus === "signed_out") {
    return view.quotaMessage?.includes("expired")
      ? (language === "en" ? "Claude Code login expired" : "Claude Code 登录已过期")
      : (language === "en" ? "Claude Code login not found" : "未找到 Claude Code 登录");
  }
  return language === "en" ? "Claude quota unavailable" : "未读取到 Claude 额度";
}

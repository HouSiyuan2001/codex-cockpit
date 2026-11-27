import type { ClaudeQuota, ClaudeQuotaWindow, CockpitMode, Language, SharedClaudeQuota } from "../types";

export const COCKPIT_MODES: readonly CockpitMode[] = ["codex", "claude", "ai"];

export function normalizeCockpitMode(value: unknown, geminiEnabled = false): CockpitMode {
  if (value === "gemini") return geminiEnabled ? "gemini" : "codex";
  return value === "claude" || value === "ai" ? value : "codex";
}

export function nextCockpitMode(mode: CockpitMode): CockpitMode {
  return COCKPIT_MODES[(COCKPIT_MODES.indexOf(mode) + 1) % COCKPIT_MODES.length];
}

function remaining(window: ClaudeQuotaWindow | null | undefined): number | null {
  if (!window || !Number.isFinite(window.usedPercent)) return null;
  return Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)) * 10) / 10;
}

export interface ClaudeCockpitView {
  quotaStatus: ClaudeQuota["status"];
  quotaMessage: string | null;
  plan: string | null;
  weeklyRemaining: number | null;
  weeklyResetsAt: string | null;
  fiveHourUsed: number | null;
  fiveHourResetsAt: string | null;
  fiveHourAwaitingRefresh: boolean;
  opusWeeklyRemaining: number | null;
}

export function buildClaudeCockpitView(quota: ClaudeQuota | null, now = new Date(), shared: SharedClaudeQuota | null = null): ClaudeCockpitView {
  const quotaReadable = quota?.status === "ok" || quota?.status === "stale";
  const fallback = quota?.status === "signed_out" || quota?.status === "unavailable" ? shared?.quota : null;
  const fiveHour = quotaReadable ? quota?.fiveHour : fallback?.fiveHour;
  const fiveHourAwaitingRefresh = Date.parse(fiveHour?.resetsAt ?? "") <= now.getTime();
  const fiveHourUsedPercent = fiveHourAwaitingRefresh ? undefined : fiveHour?.usedPercent;
  const sharedWeek = fallback?.sevenDay;
  const weekly = quotaReadable ? quota?.sevenDay : Date.parse(sharedWeek?.resetsAt ?? "") <= now.getTime() ? null : sharedWeek;
  return {
    quotaStatus: quota?.status ?? "loading",
    quotaMessage: quota?.message ?? null,
    plan: quota?.plan ?? null,
    weeklyRemaining: remaining(weekly),
    weeklyResetsAt: weekly?.resetsAt ?? null,
    fiveHourUsed: fiveHourUsedPercent !== undefined && Number.isFinite(fiveHourUsedPercent)
      ? Math.round(Math.max(0, Math.min(100, fiveHourUsedPercent)) * 10) / 10
      : null,
    fiveHourResetsAt: fiveHourAwaitingRefresh ? null : fiveHour?.resetsAt ?? null,
    fiveHourAwaitingRefresh,
    opusWeeklyRemaining: quotaReadable ? remaining(quota?.sevenDayOpus) : null,
  };
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

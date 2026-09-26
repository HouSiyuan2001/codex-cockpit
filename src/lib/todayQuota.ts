import type { CodexDailyUsage, RateLimitSnapshot, SnapshotStatus, UsageWindow } from "../types";
import type { DailyRecommendation } from "./dynamicQuota";
import { endOfUsageDay, usageDateKey } from "./usageDay";

export type TodayQuotaAdviceState = "live" | "fallback" | "stale" | "missing";

export interface TodayQuotaAdvice {
  state: TodayQuotaAdviceState;
  source: RateLimitSnapshot["source"] | "local-session" | "none";
  usedPercent: number | null;
  remainingPercent: number | null;
  todaySuggestedPercent: number | null;
  todayUsedPercent: number | null;
  todayRemainingPercent: number | null;
  safetyCapPercent: number | null;
  resetRiskPercent: number | null;
  recommendationSource: DailyRecommendation["source"] | "linear-fallback" | "none";
  resetsAt: string | null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10;
}

export function dailyUsageRatio(usedPercent: number | null, suggestedPercent: number | null): number | null {
  if (usedPercent === null || suggestedPercent === null || suggestedPercent <= 0) return null;
  return roundPercent(Math.max(0, usedPercent) / suggestedPercent * 100);
}

function effectiveStatus(status: SnapshotStatus, source: TodayQuotaAdvice["source"]): TodayQuotaAdviceState {
  if (status === "stale") return "stale";
  if (source === "app-server") return "live";
  if (source === "legacy-api" || source === "local-session") return "fallback";
  return "missing";
}

export function buildTodayQuotaAdvice({
  rateLimitSnapshot,
  weeklyWindow,
  dailyUsage,
  status,
  dynamicRecommendation = null,
  now = new Date(),
}: {
  rateLimitSnapshot?: RateLimitSnapshot | null;
  weeklyWindow?: UsageWindow | null;
  dailyUsage?: CodexDailyUsage | null;
  status: SnapshotStatus;
  dynamicRecommendation?: DailyRecommendation | null;
  now?: Date;
}): TodayQuotaAdvice {
  const officialUsed = rateLimitSnapshot && Number.isFinite(rateLimitSnapshot.usedPercent)
    ? clampPercent(rateLimitSnapshot.usedPercent)
    : null;
  const fallbackRemaining = weeklyWindow && Number.isFinite(weeklyWindow.remainingPercent)
    ? clampPercent(weeklyWindow.remainingPercent)
    : null;
  const usedPercent = officialUsed ?? (fallbackRemaining === null ? null : 100 - fallbackRemaining);
  const remainingPercent = usedPercent === null ? fallbackRemaining : roundPercent(100 - usedPercent);
  const source = rateLimitSnapshot?.source ?? (weeklyWindow ? "local-session" : "none");
  const resetsAt = rateLimitSnapshot?.resetsAt ?? weeklyWindow?.resetsAt ?? null;
  const resetMs = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  const nowMs = now.getTime();
  const remainingWindowMs = Number.isFinite(resetMs) ? resetMs - nowMs : Number.NaN;
  const todayWindowMs = Number.isFinite(resetMs)
    ? Math.max(0, Math.min(resetMs, endOfUsageDay(now)) - nowMs)
    : Number.NaN;
  const linearSuggestedPercent = remainingPercent !== null
    && Number.isFinite(remainingWindowMs)
    && remainingWindowMs > 0
    && Number.isFinite(todayWindowMs)
    ? roundPercent(remainingPercent * Math.min(1, todayWindowMs / remainingWindowMs))
    : null;
  const state = effectiveStatus(status, source);
  const hasPlan = state !== "stale" || Boolean(dynamicRecommendation?.dayPlan);
  const todaySuggestedPercent = hasPlan && dynamicRecommendation
    ? roundPercent(dynamicRecommendation.targetPercent)
    : linearSuggestedPercent;
  const todayUsedPercent = dynamicRecommendation?.dayPlan
    ? dynamicRecommendation.todayUsedPercent ?? null
    : dailyUsage
    && dailyUsage.coverage !== "unavailable"
    && dailyUsage.localDate === usageDateKey(now)
    && Number.isFinite(dailyUsage.observedUsedPercent)
    ? roundPercent(Math.max(0, dailyUsage.observedUsedPercent))
    : null;
  const todayRemainingPercent = todaySuggestedPercent === null || todayUsedPercent === null
    ? null
    : roundPercent(Math.max(0, todaySuggestedPercent - todayUsedPercent));

  return {
    state,
    source,
    usedPercent,
    remainingPercent,
    todaySuggestedPercent,
    todayUsedPercent,
    todayRemainingPercent,
    safetyCapPercent: hasPlan ? dynamicRecommendation?.safetyCapPercent ?? null : null,
    resetRiskPercent: hasPlan ? dynamicRecommendation?.resetRiskPercent ?? null : null,
    recommendationSource: hasPlan
      ? dynamicRecommendation?.source ?? "linear-fallback"
      : "linear-fallback",
    resetsAt,
  };
}

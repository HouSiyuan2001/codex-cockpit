import type { DailyPaceBaseline, ProviderSnapshot, ResetForecast, UsageWindow } from "../types";
import { endOfUsageDay, usageDateKey } from "./usageDay";

export type QuotaPeriod = "5h" | "weekly" | "monthly";
export type QuotaPaceStatus = "on_track" | "over_pace" | "unknown";
export type QuotaPaceUnit = "hour" | "day";

export interface NamedQuotaWindow {
  period: QuotaPeriod;
  window: UsageWindow;
}

export interface QuotaPace {
  status: QuotaPaceStatus;
  usedPercent: number;
  todayUsedPercent: number;
  recommendedUsedPercent: number | null;
  todayRemainingPercent: number | null;
  overByPercent: number;
  averageRate: number;
  unit: QuotaPaceUnit;
}

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const SCHEDULE_TOLERANCE_PERCENT = 0.5;
const CLOCK_TOLERANCE_MS = 2 * 60_000;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function paceBaselineKey(provider: ProviderSnapshot["provider"], period: QuotaPeriod): string {
  return `${provider}:${period}`;
}

export function forecastAdjustedResetAt(resetsAt: string, now: Date, forecast: ResetForecast | null): string {
  const guaranteedResetAt = Date.parse(resetsAt);
  const nowMs = now.getTime();
  if (!forecast || !Number.isFinite(guaranteedResetAt) || guaranteedResetAt <= nowMs
    || !Number.isFinite(forecast.score) || !Number.isFinite(forecast.windowHours)) return resetsAt;
  const probability = clamp(forecast.score, 0, 100) / 100;
  const forecastWindowMs = Math.max(0, forecast.windowHours) * HOUR_MS;
  if (probability <= 0 || !Number.isFinite(forecastWindowMs) || forecastWindowMs <= 0) return resetsAt;

  // Radar reports a chance within a window, not an exact time. Treat the
  // midpoint as the conditional reset time, then retain the regular Codex
  // reset as the probability-weighted fallback.
  const guaranteedRemainingMs = guaranteedResetAt - nowMs;
  const conditionalResetMs = Math.min(guaranteedRemainingMs, forecastWindowMs / 2);
  const expectedRemainingMs = probability * conditionalResetMs + (1 - probability) * guaranteedRemainingMs;
  return new Date(nowMs + expectedRemainingMs).toISOString();
}

export function refreshDailyPaceBaselines(
  current: Record<string, DailyPaceBaseline>,
  snapshots: ProviderSnapshot[],
  now = new Date(),
  resetProviders: ReadonlySet<string> = new Set(),
  resetForecast: ResetForecast | null = null,
): Record<string, DailyPaceBaseline> {
  const next: Record<string, DailyPaceBaseline> = {};
  const localDate = usageDateKey(now);
  for (const snapshot of snapshots) {
    const windows = trackedQuotaWindows(snapshot);
    if (windows.length === 0 && ["unavailable", "stale", "loading"].includes(snapshot.status)) {
      for (const [key, baseline] of Object.entries(current)) {
        if (baseline.provider === snapshot.provider) next[key] = baseline;
      }
      continue;
    }
    for (const { period, window } of windows) {
      if (!window.resetsAt || !Number.isFinite(Date.parse(window.resetsAt))) continue;
      const key = paceBaselineKey(snapshot.provider, period);
      const existing = current[key];
      const quotaRestored = existing && window.remainingPercent > existing.remainingPercent + SCHEDULE_TOLERANCE_PERCENT;
      const sameCycle = existing?.resetsAt === window.resetsAt;
      const cycleReset = resetProviders.has(snapshot.provider) || Boolean(quotaRestored);
      const canReuse = existing
        && !resetProviders.has(snapshot.provider)
        && !quotaRestored
        && existing.localDate === localDate
        && existing.resetsAt === window.resetsAt;
      const applicableForecast = snapshot.provider === "codex" && period === "weekly" && !resetProviders.has(snapshot.provider)
        ? resetForecast
        : null;
      const inferredCycleStartedAt = new Date(Date.parse(window.resetsAt) - Math.max(1, window.windowSeconds * 1000)).toISOString();
      const currentRemaining = clamp(window.remainingPercent, 0, 100);
      next[key] = canReuse ? existing : {
        provider: snapshot.provider,
        period,
        localDate,
        capturedAt: now.toISOString(),
        remainingPercent: currentRemaining,
        resetsAt: window.resetsAt,
        cycleStartedAt: cycleReset
          ? now.toISOString()
          : sameCycle && existing ? existing.cycleStartedAt : inferredCycleStartedAt,
        cycleStartRemainingPercent: cycleReset
          ? currentRemaining
          : sameCycle && existing ? existing.cycleStartRemainingPercent : 100,
        planningResetsAt: forecastAdjustedResetAt(window.resetsAt, now, applicableForecast),
        resetForecastScore: applicableForecast ? clamp(applicableForecast.score, 0, 100) : null,
        resetForecastWindowHours: applicableForecast ? Math.max(0, applicableForecast.windowHours) : null,
      };
    }
  }
  return next;
}

export function providerQuotaWindows(snapshot: ProviderSnapshot): NamedQuotaWindow[] {
  const windows: NamedQuotaWindow[] = [];
  if (snapshot.shortWindow) windows.push({ period: "5h", window: snapshot.shortWindow });
  if (snapshot.weeklyWindow) windows.push({ period: "weekly", window: snapshot.weeklyWindow });
  if (snapshot.monthlyWindow) windows.push({ period: "monthly", window: snapshot.monthlyWindow });
  return windows;
}

export function trackedQuotaWindows(snapshot: ProviderSnapshot): NamedQuotaWindow[] {
  const windows = providerQuotaWindows(snapshot);
  return snapshot.provider === "codex"
    ? windows.filter((item) => item.period === "weekly")
    : windows;
}

export function calculateQuotaPace(window: UsageWindow, now = new Date(), baseline: DailyPaceBaseline | null = null): QuotaPace {
  const durationMs = Math.max(1, window.windowSeconds * 1000);
  const unit: QuotaPaceUnit = durationMs <= DAY_MS ? "hour" : "day";
  const unitMs = unit === "hour" ? HOUR_MS : DAY_MS;
  const usedPercent = 100 - clamp(window.remainingPercent, 0, 100);
  const baselineRate = 100 / (durationMs / unitMs);
  const resetAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;

  if (!Number.isFinite(resetAt)) {
    return {
      status: usedPercent <= SCHEDULE_TOLERANCE_PERCENT ? "on_track" : "unknown",
      usedPercent,
      todayUsedPercent: usedPercent,
      recommendedUsedPercent: null,
      todayRemainingPercent: null,
      overByPercent: 0,
      averageRate: baselineRate,
      unit,
    };
  }

  const startsAt = resetAt - durationMs;
  const nowMs = now.getTime();
  const matchingBaseline = baseline?.resetsAt === window.resetsAt ? baseline : null;
  const matchingBaselineAt = matchingBaseline?.localDate === usageDateKey(now)
    ? Date.parse(matchingBaseline.capturedAt)
    : Number.NaN;
  const savedCycleStartedAt = matchingBaseline ? Date.parse(matchingBaseline.cycleStartedAt) : Number.NaN;
  const hasTrackedCycleStart = Number.isFinite(savedCycleStartedAt)
    && savedCycleStartedAt <= nowMs
    && savedCycleStartedAt < resetAt
    && nowMs <= resetAt + CLOCK_TOLERANCE_MS;
  if ((nowMs < startsAt - CLOCK_TOLERANCE_MS && !hasTrackedCycleStart) || nowMs > resetAt + CLOCK_TOLERANCE_MS) {
    return { status: "unknown", usedPercent, todayUsedPercent: usedPercent, recommendedUsedPercent: null, todayRemainingPercent: null, overByPercent: 0, averageRate: baselineRate, unit };
  }

  const remainingPercent = clamp(window.remainingPercent, 0, 100);
  const baselineAt = Number.isFinite(matchingBaselineAt) ? matchingBaselineAt : nowMs;
  const baselineRemaining = baselineAt <= nowMs && Number.isFinite(baselineAt)
    ? clamp(matchingBaseline?.remainingPercent ?? remainingPercent, 0, 100)
    : remainingPercent;
  const cycleStartedAt = hasTrackedCycleStart ? savedCycleStartedAt : startsAt;
  const cycleStartRemaining = hasTrackedCycleStart
    ? clamp(matchingBaseline?.cycleStartRemainingPercent ?? 100, 0, 100)
    : 100;
  const cycleStartUsed = 100 - cycleStartRemaining;
  const recommendedUsedPercent = clamp(
    cycleStartUsed + cycleStartRemaining * ((nowMs - cycleStartedAt) / Math.max(1, resetAt - cycleStartedAt)),
    0,
    100,
  );
  const savedPlanningResetAt = matchingBaseline ? Date.parse(matchingBaseline.planningResetsAt) : Number.NaN;
  const planningResetAt = Number.isFinite(savedPlanningResetAt) && savedPlanningResetAt >= baselineAt && savedPlanningResetAt <= resetAt
    ? savedPlanningResetAt
    : resetAt;
  const baselineRemainingMs = Math.max(0, planningResetAt - baselineAt);
  const planningHorizon = Math.min(planningResetAt, endOfUsageDay(new Date(baselineAt)));
  const horizonMs = Math.max(0, planningHorizon - baselineAt);
  const dailyBudget = baselineRemainingMs > 0
    ? clamp(baselineRemaining * (horizonMs / baselineRemainingMs), 0, baselineRemaining)
    : 0;
  const consumedToday = Math.max(0, baselineRemaining - remainingPercent);
  const averageRate = baselineRemainingMs > 0 ? baselineRemaining / (baselineRemainingMs / unitMs) : 0;
  const tracksCodexResetUsage = matchingBaseline?.provider === "codex" && matchingBaseline.period === "weekly";
  const todayUsedPercent = usedPercent;
  const plannedUsedByEndOfDay = clamp(
    cycleStartUsed + cycleStartRemaining * (
      (Math.min(planningResetAt, endOfUsageDay(now)) - cycleStartedAt) / Math.max(1, planningResetAt - cycleStartedAt)
    ),
    cycleStartUsed,
    100,
  );
  const todayRemainingPercent = tracksCodexResetUsage
    ? clamp(plannedUsedByEndOfDay - todayUsedPercent, 0, remainingPercent)
    : clamp(dailyBudget - consumedToday, 0, remainingPercent);
  const overByPercent = Math.max(0, usedPercent - recommendedUsedPercent);
  return {
    status: overByPercent <= SCHEDULE_TOLERANCE_PERCENT ? "on_track" : "over_pace",
    usedPercent,
    todayUsedPercent,
    recommendedUsedPercent,
    todayRemainingPercent,
    overByPercent,
    averageRate,
    unit,
  };
}

export function mostOverPaceWindow(
  snapshot: ProviderSnapshot,
  now = new Date(),
  baselines: Record<string, DailyPaceBaseline> = {},
): (NamedQuotaWindow & { pace: QuotaPace }) | null {
  return trackedQuotaWindows(snapshot)
    .map((item) => ({ ...item, pace: calculateQuotaPace(item.window, now, baselines[paceBaselineKey(snapshot.provider, item.period)] ?? null) }))
    .filter((item) => item.pace.status === "over_pace")
    .sort((left, right) => right.pace.overByPercent - left.pace.overByPercent)[0] ?? null;
}

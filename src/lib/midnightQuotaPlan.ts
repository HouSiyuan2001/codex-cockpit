import type { ProviderSnapshot, QuotaHistoryPoint, ResetForecast } from "../types";
import { planRemainingQuota, type DailyRecommendation } from "./dynamicQuota";
import { trackedQuotaWindows } from "./quotaPace";

const DAY = 86_400_000;
const GRACE = 30 * 60_000;
export interface MidnightPlanBasis {
  localDate: string;
  anchorAt: string;
  capturedAt: string;
  remainingPercent: number;
  kind: "midnight" | "near-midnight" | "first-observation";
}

/** Calendar midnight in Beijing, deliberately separate from the historical 04:00 usage ledger. */
export function beijingMidnight(now: Date): number {
  const shifted = new Date(now.getTime() + 8 * 3_600_000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), -8);
}

export function buildMidnightQuotaPlan({ history, snapshot, riskPercent, forecast, fatigueKneePercent, now }: {
  history: readonly QuotaHistoryPoint[];
  snapshot: ProviderSnapshot | null;
  riskPercent: number | null;
  forecast: ResetForecast | null;
  fatigueKneePercent: number;
  now: Date;
}): DailyRecommendation | null {
  if (!snapshot || snapshot.provider !== "codex" || !["ok", "stale"].includes(snapshot.status)) return null;
  const weekly = trackedQuotaWindows(snapshot).find(row => row.period === "weekly")?.window;
  if (!weekly || !Number.isFinite(weekly.remainingPercent)) return null;
  const reset = Date.parse(weekly.resetsAt ?? "");
  if (!Number.isFinite(reset) || reset <= now.getTime()) return null;
  const midnight = beijingMidnight(now);
  const cycle = Math.round(reset / 60_000);
  const livePoint: QuotaHistoryPoint = {
    provider: "codex", status: "ok", capturedAt: snapshot.updatedAt,
    metric: weekly.remainingPercent, metricKind: "percent", resetsAt: weekly.resetsAt,
  };
  const points = [...history, ...(snapshot.status === "ok" ? [livePoint] : [])].filter(point => point.provider === "codex" && point.status === "ok"
    && point.metricKind === "percent" && point.metric !== null && Number.isFinite(point.metric)
    && Math.round(Date.parse(point.resetsAt ?? "") / 60_000) === cycle
    && Date.parse(point.capturedAt) >= midnight - GRACE && Date.parse(point.capturedAt) <= now.getTime())
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  // Prefer the last pre-midnight observation, otherwise freeze the first observation of this cycle/day.
  const before = points.filter(point => Date.parse(point.capturedAt) <= midnight).at(-1);
  const first = before ?? points[0];
  if (!first || first.metric === null) return null;
  const captured = Date.parse(first.capturedAt);
  const cycleChangedToday = history.some(point => point.provider === "codex" && point.status === "ok"
    && point.metricKind === "percent" && Date.parse(point.capturedAt) >= midnight
    && Date.parse(point.capturedAt) < captured
    && Number.isFinite(Date.parse(point.resetsAt ?? ""))
    && Math.round(Date.parse(point.resetsAt!) / 60_000) !== cycle);
  const close = !cycleChangedToday && Math.abs(captured - midnight) <= GRACE;
  const anchor = close ? midnight : captured;
  const remaining = Math.min(100, Math.max(0, first.metric));
  const dayPlan: MidnightPlanBasis = {
    localDate: new Date(midnight + 8 * 3_600_000).toISOString().slice(0, 10),
    anchorAt: new Date(anchor).toISOString(), capturedAt: first.capturedAt,
    remainingPercent: remaining,
    kind: captured === midnight ? "midnight" : close ? "near-midnight" : "first-observation",
  };
  const effectiveRisk = Math.min(100, Math.max(0, riskPercent ?? (forecast?.resetAnnounced ? 100 : forecast?.tomorrowRiskPercent ?? forecast?.score ?? 10)));
  const days = (reset - anchor) / DAY;
  const fraction = Math.min(1, Math.max(0, (midnight + DAY - anchor) / DAY));
  const weekday = (new Date(midnight + 8 * 3_600_000).getUTCDay() + 6) % 7;
  const result = planRemainingQuota({ remainingPercent: remaining, daysUntilReset: days,
    todayFractionRemaining: fraction, todayUsedPercent: 0, tomorrowRiskPercent: effectiveRisk,
    fatigueKneePercent, isWeekend: weekday >= 5 });
  // Do not let later use, clock ticks, or harmless balance rebounds change the frozen daily target.
  const minimum = Math.min(remaining, snapshot.status === "ok" ? weekly.remainingPercent : remaining, ...points.filter(point => Date.parse(point.capturedAt) >= anchor).map(point => point.metric!));
  const used = Math.round(Math.max(0, remaining - minimum) * 10) / 10;
  return {
    dayPlan, targetPercent: result.suggestedUsagePercent, safetyCapPercent: result.softCapPercent,
    todayUsedPercent: used, additionalUsagePercent: Math.round(Math.max(0, result.suggestedUsagePercent - used) * 10) / 10,
    todayFractionRemaining: fraction, resetRiskPercent: effectiveRisk, fatigueKneePercent,
    carryInPercent: 0, futureDays: days, cycleAge: Math.max(0, 7 - days), weekday,
    historySampleCount: forecast?.historySampleCount ?? 0,
    source: forecast ? "remote-model" : "local-fallback", policyVersion: "beijing-midnight-plan-v1",
  };
}

import type { ClaudePlanState, ClaudeQuota, ClaudeQuotaDay, ClaudeResetForecast, ComfortPrompt, QuotaDailyUsage, ResetWatch } from "../types";
import { MAX_DAILY_OBSERVED_PERCENT } from "../types";
import { normalizeComfortFeedbackRecords, normalizeComfortPromptedKeys } from "./comfortFeedback";
import { CLAUDE_RESETS_URL } from "./externalLinks";
import { beijingMidnight } from "./midnightQuotaPlan";
import { RESET_WATCH_MAX_AGE_MS } from "./resetWatch";
import { sharedRecommendation } from "./sharedDailyPlan";
import { dailyUsageRatio, type TodayQuotaAdvice } from "./todayQuota";
import type { DailyRecommendation } from "./dynamicQuota";
import { localDateKey } from "./usageDay";

const DAY_MS = 86_400_000;
const GRACE_MS = 30 * 60_000;
const SAME_RESET_MS = 60_000;
const REFILL_DROP_PERCENT = 1;
const MAX_DAYS = 180;
const round = (value: number) => Math.round(value * 10) / 10;
const percent = (value: unknown, max = 100): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const dateKey = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d\d-\d\d$/.test(value)
  && new Date(value + "T00:00:00Z").toJSON()?.slice(0, 10) === value;

export const EMPTY_CLAUDE_PLAN: ClaudePlanState = { quotaDays: [], cap: null, manualRiskPercent: null, comfortFeedback: [], comfortPromptedDates: [] };

export function normalizeClaudePlan(value: unknown): ClaudePlanState {
  if (!value || typeof value !== "object") return EMPTY_CLAUDE_PLAN;
  const candidate = value as Partial<ClaudePlanState>;
  const quotaDays = new Map<string, ClaudeQuotaDay>();
  for (const day of Array.isArray(candidate.quotaDays) ? candidate.quotaDays : []) {
    if (!day || !dateKey(day.localDate) || !timestamp(day.capturedAt) || !timestamp(day.lastObservedAt) || !timestamp(day.resetsAt)
      || !percent(day.baselineUsed) || !percent(day.highWaterUsed) || day.highWaterUsed < day.baselineUsed
      || !percent(day.earlierCycleUsed, MAX_DAILY_OBSERVED_PERCENT) || !Number.isInteger(day.sampleCount) || day.sampleCount < 1 || day.sampleCount > 10000
      || typeof day.nearMidnight !== "boolean" || day.localDate !== localDateKey(new Date(day.capturedAt))
      || day.localDate !== localDateKey(new Date(day.lastObservedAt)) || Date.parse(day.capturedAt) > Date.parse(day.lastObservedAt)
      || Date.parse(day.lastObservedAt) >= Date.parse(day.resetsAt)) continue;
    const previous = quotaDays.get(day.localDate);
    const { pendingDrop, ...fields } = day;
    const validDrop = pendingDrop && timestamp(pendingDrop.capturedAt) && percent(pendingDrop.usedPercent)
      && Date.parse(pendingDrop.capturedAt) >= Date.parse(day.capturedAt) && Date.parse(pendingDrop.capturedAt) <= Date.parse(day.lastObservedAt)
      && day.highWaterUsed - pendingDrop.usedPercent >= REFILL_DROP_PERCENT;
    if (!previous || Date.parse(day.lastObservedAt) > Date.parse(previous.lastObservedAt)) {
      quotaDays.set(day.localDate, validDrop ? { ...fields, pendingDrop } : fields);
    }
  }
  return {
    quotaDays: [...quotaDays.values()].sort((a, b) => a.localDate.localeCompare(b.localDate)).slice(-MAX_DAYS),
    cap: candidate.cap && dateKey(candidate.cap.localDate) && percent(candidate.cap.percent) ? candidate.cap : null,
    manualRiskPercent: percent(candidate.manualRiskPercent) ? candidate.manualRiskPercent : null,
    comfortFeedback: normalizeComfortFeedbackRecords(candidate.comfortFeedback).filter(record => !record.personId),
    comfortPromptedDates: normalizeComfortPromptedKeys(candidate.comfortPromptedDates),
  };
}

function usedToday(day: ClaudeQuotaDay) {
  return round(Math.min(MAX_DAILY_OBSERVED_PERCENT, day.earlierCycleUsed + day.highWaterUsed - day.baselineUsed));
}

export function observeClaudeQuota(state: ClaudePlanState, quota: ClaudeQuota | null, now = new Date(), legacyBaseline?: { localDate: string; weeklyUsedPercent: number } | null): ClaudePlanState {
  const window = quota?.sevenDay;
  const capturedAt = quota?.observedAt;
  const resetsAt = window?.resetsAt;
  if (quota?.status !== "ok" || !percent(window?.usedPercent) || !timestamp(capturedAt) || !timestamp(resetsAt)) return state;
  const captured = Date.parse(capturedAt), reset = Date.parse(resetsAt);
  if (captured > now.getTime() || captured >= reset || reset <= now.getTime()) return state;
  const localDate = localDateKey(new Date(captured));
  const previous = state.quotaDays.at(-1);
  if (previous && Date.parse(previous.lastObservedAt) >= captured) return state;
  const used = window.usedPercent;
  const sameCycle = previous && Math.abs(reset - Date.parse(previous.resetsAt)) < SAME_RESET_MS
    && captured < Date.parse(previous.resetsAt);
  if (previous?.localDate === localDate && sameCycle) {
    // A banked reset can refill usage without moving the weekly deadline.
    // Wait for a second lower sample, so a transient dip isn't double counted.
    const low = previous.highWaterUsed - used >= REFILL_DROP_PERCENT;
    if (low && previous.pendingDrop) {
      const baselineUsed = Math.min(previous.pendingDrop.usedPercent, used);
      const next: ClaudeQuotaDay = {
        localDate, capturedAt: previous.pendingDrop.capturedAt, lastObservedAt: capturedAt, resetsAt,
        baselineUsed, highWaterUsed: used, earlierCycleUsed: usedToday(previous), sampleCount: 2, nearMidnight: false,
      };
      return { ...state, quotaDays: [...state.quotaDays.slice(0, -1), next] };
    }
    const next = { ...previous, highWaterUsed: Math.max(previous.highWaterUsed, used), lastObservedAt: capturedAt,
      resetsAt, sampleCount: Math.min(10000, previous.sampleCount + 1), pendingDrop: low ? { capturedAt, usedPercent: used } : undefined };
    return { ...state, quotaDays: [...state.quotaDays.slice(0, -1), next] };
  }
  const midnight = beijingMidnight(new Date(captured));
  const continuingDay = previous?.localDate === localDate;
  const nearMidnight = !continuingDay && captured - midnight <= GRACE_MS;
  const nearMidnightPrior = nearMidnight && sameCycle && previous && !previous.pendingDrop
    && midnight - Date.parse(previous.lastObservedAt) <= GRACE_MS;
  const legacyUsed = !previous && legacyBaseline?.localDate === localDate && percent(legacyBaseline.weeklyUsedPercent, used) ? legacyBaseline.weeklyUsedPercent : null;
  const baselineUsed = nearMidnightPrior ? previous.highWaterUsed : legacyUsed ?? used;
  const day: ClaudeQuotaDay = {
    localDate, capturedAt, lastObservedAt: capturedAt, resetsAt,
    baselineUsed, highWaterUsed: Math.max(used, baselineUsed), earlierCycleUsed: continuingDay ? usedToday(previous) : 0,
    sampleCount: nearMidnightPrior ? 2 : 1, nearMidnight,
  };
  return { ...state, quotaDays: [...(continuingDay ? state.quotaDays.slice(0, -1) : state.quotaDays), day].slice(-MAX_DAYS) };
}

export function claudeQuotaDays(state: ClaudePlanState): QuotaDailyUsage[] {
  return state.quotaDays.flatMap(day => {
    const used = usedToday(day);
    // An isolated reading only establishes an anchor. It cannot prove zero use today.
    if (used === 0 && day.sampleCount < 2) return [];
    return [{ localDate: day.localDate, observedUsedPercent: used, sampleCount: day.sampleCount, firstObservedAt: day.capturedAt,
      lastObservedAt: day.lastObservedAt, coverage: "partial" as const, source: "claude-subscription" as const }];
  });
}

export function claudeResetWatch(forecast: ClaudeResetForecast | null, now: Date): ResetWatch | null {
  const notice = forecast?.notice;
  const checked = Date.parse(forecast?.checkedAt ?? "");
  const observed = Date.parse(notice?.observedAt ?? "");
  const expires = Date.parse(notice?.expiresAt ?? "");
  const current = now.getTime();
  if (!notice || ![checked, observed, expires].every(Number.isFinite) || checked > current + 60_000
    || current - checked >= RESET_WATCH_MAX_AGE_MS || observed > current || expires <= current || expires <= observed) return null;
  const url = /^https:\/\/x\.com\/(ClaudeDevs|bcherny|lydiahallie)\/status\/\d{1,32}$/.test(notice.announcementUrl)
    ? notice.announcementUrl : CLAUDE_RESETS_URL;
  return { ...notice, announcementUrl: url, signalKind: "claude-announcement", level: "strong", resetChancePercent: null };
}

export function buildClaudePlan(
  state: ClaudePlanState, quota: ClaudeQuota | null, fatigueKneePercent: number, now: Date,
) {
  const localDate = localDateKey(now);
  const midnight = beijingMidnight(now);
  const risk = state.manualRiskPercent ?? 0;
  const riskSource = state.manualRiskPercent !== null ? "manual" as const : "scheduled-only" as const;
  const readable = quota?.status === "ok" || quota?.status === "stale";
  const weekly = readable ? quota.sevenDay : null;
  const observedUsed = percent(weekly?.usedPercent) ? weekly.usedPercent : null;
  const reset = Date.parse(weekly?.resetsAt ?? "");
  const day = state.quotaDays.find(item => item.localDate === localDate);
  const todayUsed = day && (day.sampleCount >= 2 || usedToday(day) > 0) ? usedToday(day) : null;
  let recommendation: DailyRecommendation | null = null;
  if (day && observedUsed !== null && reset > now.getTime() && Math.abs(reset - Date.parse(day.resetsAt)) < SAME_RESET_MS) {
    const anchor = day.nearMidnight ? midnight : Date.parse(day.capturedAt);
    const remainingPercent = 100 - day.baselineUsed;
    const basis = { localDate, anchorAt: new Date(anchor).toISOString(), resetsAt: day.resetsAt, remainingPercent };
    const cycleTarget = sharedRecommendation(basis, risk);
    const target = round(Math.min(100, cycleTarget + day.earlierCycleUsed));
    recommendation = {
      dayPlan: { ...basis, capturedAt: day.capturedAt, kind: day.nearMidnight ? "near-midnight" : "first-observation" },
      targetPercent: target, safetyCapPercent: round(Math.min(100, remainingPercent + day.earlierCycleUsed)),
      todayUsedPercent: todayUsed ?? undefined, additionalUsagePercent: round(Math.max(0, target - (todayUsed ?? 0))),
      todayFractionRemaining: Math.min(1, Math.max(0, (midnight + DAY_MS - anchor) / DAY_MS)),
      resetRiskPercent: risk, fatigueKneePercent, carryInPercent: 0, futureDays: (reset - anchor) / DAY_MS,
      cycleAge: Math.max(0, 7 - (reset - anchor) / DAY_MS), weekday: (new Date(midnight + 8 * 3_600_000).getUTCDay() + 6) % 7,
      historySampleCount: 0,
      source: "local-fallback",
      policyVersion: "shared-account-plan-v2",
    };
  }
  const cap = state.cap?.localDate === localDate ? state.cap.percent : recommendation?.targetPercent ?? null;
  const advice: TodayQuotaAdvice = {
    state: quota?.status === "stale" ? "stale" : observedUsed !== null ? "live" : "missing",
    source: observedUsed !== null ? "claude-subscription" : "none", usedPercent: observedUsed,
    remainingPercent: observedUsed === null ? null : round(100 - observedUsed),
    todaySuggestedPercent: recommendation?.targetPercent ?? null, todayUsedPercent: todayUsed,
    todayRemainingPercent: recommendation && todayUsed !== null ? round(Math.max(0, recommendation.targetPercent - todayUsed)) : null,
    safetyCapPercent: recommendation?.safetyCapPercent ?? null, resetRiskPercent: state.manualRiskPercent,
    recommendationSource: recommendation?.source ?? "none", resetsAt: weekly?.resetsAt ?? null,
  };
  return { advice, cap, ratio: dailyUsageRatio(todayUsed, cap), recommendation, riskSource };
}

export function buildClaudeComfortPrompt(target: Pick<ComfortPrompt, "localDate" | "isCatchUp">, usage: QuotaDailyUsage | undefined): ComfortPrompt {
  return {
    ...target,
    observedUsedPercent: usage?.observedUsedPercent ?? null,
    usageObservedAt: usage?.lastObservedAt ?? null,
    usageCoverage: usage?.coverage ?? "unavailable",
    usageSource: usage ? "official-snapshot" : "unavailable",
  };
}

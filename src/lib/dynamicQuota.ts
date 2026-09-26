import type { CodexDailyUsage, DailyPaceBaseline, DailyRecommendationRecord, DailyUsageSummary, ResetForecast, UsageWindow } from "../types";
import { endOfUsageDay, usageDateKey } from "./usageDay";

export const DYNAMIC_POLICY_VERSION = "p020-t027-remaining-reset-v1";
export const DEFAULT_DAILY_FLOOR = 0.1;
export const DEFAULT_WEEKDAY_HAZARDS = [0.1, 0.7, 0.1, 0.1, 0.1, 0.7, 0.1] as const;
export const DEFAULT_SMOOTH_KNEE_PERCENT = 25;
export const DEFAULT_ENDPOINT_FRACTION = 0.2;
export const DEFAULT_SMOOTH_KNEE_TAU = 0.02;
export const DEFAULT_SMOOTH_KNEE_POWER = 1.5;
export const DEFAULT_SMOOTH_KNEE_SHARPNESS = 4.3;
export const DEFAULT_CARRY_RELEASE = 0.75;
export const DEFAULT_FUTURE_DAYS = 5;
export const MAX_MANUAL_RESET_RISK_OVERRIDE_PERCENT = 100;

const MODEL_QUOTA_STEPS = 240;
const MAX_DAILY_RECOMMENDATIONS = 600;
const DAY_MS = 24 * 60 * 60_000;

const FORGET_PROBABILITY = [0.02, 0.02, 0.02, 0.02, 0.03, 0.28, 0.38] as const;
const REMEMBERED_MULTIPLIER_MEAN = [1.05, 1.06, 1.06, 1.07, 1.15, 0.7, 0.55] as const;
const DAILY_CAPACITY = [0.2, 0.2, 0.2, 0.2, 0.22, 0.12, 0.1] as const;

export interface DailyRecommendation {
  dayPlan?: import("./midnightQuotaPlan").MidnightPlanBasis;
  additionalUsagePercent?: number;
  todayUsedPercent?: number;
  todayFractionRemaining?: number;
  targetPercent: number;
  safetyCapPercent: number;
  resetRiskPercent: number;
  fatigueKneePercent: number;
  carryInPercent: number;
  futureDays: number;
  cycleAge: number;
  weekday: number;
  historySampleCount: number;
  source: "remote-model" | "remote-history" | "local-fallback";
  policyVersion: string;
}

export interface FatigueAwareRecommendationInput {
  balance: number;
  cycleAge: number;
  nextResetHazard: number;
  carryIn?: number;
  fatigueKneePercent?: number;
  carryRelease?: number;
  futureDays?: number;
  advanceNotice?: boolean;
}

export interface FatigueAwareRecommendation {
  target: number;
  safetyCap: number;
  freshTarget: number;
  carryIn: number;
  futureDays: number;
}

export interface CalibratedRiskQuotaInput {
  remainingPercent: number;
  tomorrowRiskPercent: number;
  fatigueKneePercent: number;
  daysLeftInCycle: number;
  isWeekend: boolean;
}

export interface CalibratedRiskQuotaPlan {
  suggestedUsagePercent: number;
  suggestedRemainingPercent: number;
  uniformPacePercent: number;
  resetRiskBoostPercent: number;
  softCapPercent: number;
}

export interface RemainingQuotaInput {
  sharedAccount?: boolean;
  remainingPercent: number;
  daysUntilReset: number;
  tomorrowRiskPercent: number;
  fatigueKneePercent: number;
  isWeekend: boolean;
  todayUsedPercent?: number;
  todayFractionRemaining?: number;
}

/** Required weekly-quota percentage points per day until natural expiry. */
export function quotaConsumptionUrgency(remainingPercent: number, daysUntilReset: number): number | null {
  if (!Number.isFinite(remainingPercent) || !Number.isFinite(daysUntilReset) || daysUntilReset <= 0) return null;
  return clamp(remainingPercent, 0, 100) / daysUntilReset;
}

/** Remaining quota is already net of all past use; never add yesterday's carry.
 * Spread it across the exact time to expiry, allocating only the rest of this
 * usage day. p² pulls future quota forward; the daily fatigue cap includes use
 * already observed today. The result is ADDITIONAL use, not a second daily total.
 */
export function planRemainingQuota(input: RemainingQuotaInput): CalibratedRiskQuotaPlan {
  const remaining = clamp(finiteOr(input.remainingPercent, 0), 0, 100);
  const days = Math.max(0, finiteOr(input.daysUntilReset, 0));
  const today = clamp(finiteOr(input.todayFractionRemaining, 1), 0, 1);
  const used = clamp(finiteOr(input.todayUsedPercent, 0), 0, 100);
  const risk = clamp(finiteOr(input.tomorrowRiskPercent, 10), 0, 100) / 100;
  const knee = clamp(finiteOr(input.fatigueKneePercent, 25), 0.1, 100);
  const urgency = quotaConsumptionUrgency(remaining, days);
  const uniform = urgency === null ? 0 : Math.min(remaining, urgency * today);
  const boost = days > 0 ? (remaining - uniform) * risk ** 2 * today : 0;
  const cap = input.sharedAccount ? remaining : Math.max(0, knee * (1 + 1.5 * risk) * (input.isWeekend ? 0.75 : 1) - used);
  const amount = days > 0 ? Math.min(remaining, uniform + boost, cap) : 0;
  return {
    suggestedUsagePercent: roundPercent(amount),
    suggestedRemainingPercent: roundPercent(remaining - amount),
    uniformPacePercent: roundPercent(uniform),
    resetRiskBoostPercent: roundPercent(boost),
    softCapPercent: roundPercent(Math.min(remaining, cap)),
  };
}

export interface RecommendationInput {
  balance: number;
  cycleAge: number;
  weekday: number;
  nextResetHazard: number;
  floor: number;
  carryRelease: number;
  riskGain: number;
  weekdayHazards: readonly number[];
  advanceNotice?: boolean;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10;
}

function finiteOr(value: number | null | undefined, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

/**
 * Public behavior-compatible port of the reset-risk dashboard's quota planner:
 * spread the balance uniformly, pull future quota forward by p^2, then apply
 * the fatigue soft cap K(1 + 1.5p), with the dashboard's 0.75 weekend factor.
 */
export function planCalibratedRiskQuota(input: CalibratedRiskQuotaInput): CalibratedRiskQuotaPlan {
  const remaining = clamp(finiteOr(input.remainingPercent, 0), 0, 100);
  const risk = clamp(finiteOr(input.tomorrowRiskPercent, 10), 0, 100) / 100;
  const fatigueKnee = clamp(finiteOr(input.fatigueKneePercent, DEFAULT_SMOOTH_KNEE_PERCENT), 0.1, 100);
  const daysLeft = Math.trunc(clamp(finiteOr(input.daysLeftInCycle, 0), 0, 7));
  const uniformPace = remaining / (daysLeft + 1);
  const resetRiskBoost = Math.max(0, remaining - uniformPace) * risk ** 2;
  const softCap = fatigueKnee * (1 + 1.5 * risk) * (input.isWeekend ? 0.75 : 1);
  const suggestedUsage = Math.min(remaining, uniformPace + resetRiskBoost, softCap);
  return {
    suggestedUsagePercent: roundPercent(suggestedUsage),
    suggestedRemainingPercent: roundPercent(remaining - suggestedUsage),
    uniformPacePercent: roundPercent(uniformPace),
    resetRiskBoostPercent: roundPercent(resetRiskBoost),
    softCapPercent: roundPercent(Math.min(remaining, softCap)),
  };
}

export function resetRiskPercentFromForecast(forecast: ResetForecast | null | undefined): number | null {
  if (!forecast) return null;
  const value = forecast.tomorrowRiskPercent ?? forecast.score;
  return Number.isFinite(value) ? roundPercent(clamp(Number(value), 0, 100)) : null;
}

export function normalizeResetRiskOverridePercent(value: number | null | undefined): number | null {
  return Number.isFinite(value) ? roundPercent(clamp(Number(value), 0, MAX_MANUAL_RESET_RISK_OVERRIDE_PERCENT)) : null;
}

export function applyResetRiskOverride(
  forecast: ResetForecast | null | undefined,
  overridePercent: number | null | undefined,
): ResetForecast | null {
  if (!forecast) return null;
  const effectiveRisk = normalizeResetRiskOverridePercent(overridePercent);
  if (effectiveRisk === null) return forecast;
  return {
    ...forecast,
    score: effectiveRisk,
    tomorrowRiskPercent: effectiveRisk,
  };
}

function positiveSoftplus(value: number): number {
  return value > 30 ? value : Math.log1p(Math.exp(value));
}

/**
 * Latest P014 smooth-knee curve. This is an efficiency eta(x; k), not a
 * token count or an official account metric. Actual productive output is
 * x * eta(x; k).
 */
export function smoothKneeEfficiency(
  usedPercent: number,
  kneePercent = DEFAULT_SMOOTH_KNEE_PERCENT,
  endpointFraction = DEFAULT_ENDPOINT_FRACTION,
  tau = DEFAULT_SMOOTH_KNEE_TAU,
  power = DEFAULT_SMOOTH_KNEE_POWER,
  sharpness = DEFAULT_SMOOTH_KNEE_SHARPNESS,
): number {
  if (!Number.isFinite(usedPercent) || usedPercent < 0) return 0;
  const knee = clamp(kneePercent, 0.1, 100) / 100;
  const endpoint = clamp(endpointFraction, 0, 1);
  const safeTau = Math.max(1e-6, tau);
  const safePower = Math.max(1e-6, power);
  const safeSharpness = Math.max(1e-6, sharpness);
  const value = clamp(usedPercent, 0, 100) / 100;
  const shoulder = (x: number) => safeTau * positiveSoftplus((x - knee) / safeTau);
  const response = (x: number) => Math.exp(-safeSharpness * x ** safePower);
  const referenceLow = response(shoulder(0));
  const referenceHigh = response(shoulder(1));
  if (Math.abs(referenceLow - referenceHigh) < 1e-12) return endpoint;
  const result = endpoint + (1 - endpoint) * (response(shoulder(value)) - referenceHigh) / (referenceLow - referenceHigh);
  return clamp(result, endpoint, 1);
}

function scheduleFromFloor(floor: number): number[] {
  const safeFloor = clamp(floor, 0, 1 / 7);
  return [1 - 6 * safeFloor, safeFloor, safeFloor, safeFloor, safeFloor, safeFloor, safeFloor];
}

function adaptiveTarget(input: RecommendationInput): number {
  const reliability = FORGET_PROBABILITY.map((value) => 1 - value);
  const availability = DAILY_CAPACITY.map((capacity, index) => reliability[index] * capacity / (DAILY_CAPACITY.slice(0, 5).reduce((sum, value) => sum + value, 0) / 5));
  const remainingDays = 7 - input.cycleAge;
  let denominator = availability[input.weekday];
  let survival = 1;
  for (let offset = 1; offset < remainingDays; offset += 1) {
    const futureWeekday = (input.weekday + offset) % 7;
    const hazard = offset === 1
      ? input.nextResetHazard
      : clamp(input.weekdayHazards[futureWeekday] ?? DEFAULT_WEEKDAY_HAZARDS[futureWeekday], 0, 1);
    survival *= 1 - hazard;
    denominator += availability[futureWeekday] * survival ** input.riskGain;
  }
  return input.balance * availability[input.weekday] / Math.max(denominator, 1e-12);
}

/** Direct TypeScript port of the latest remote `recommend_today` function. */
export function recommendToday(input: RecommendationInput): { target: number; safetyCap: number } {
  const balance = clamp(input.balance, 0, 1);
  const cycleAge = Math.trunc(clamp(input.cycleAge, 0, 6));
  const weekday = Math.trunc(clamp(input.weekday, 0, 6));
  const nextResetHazard = clamp(input.nextResetHazard, 0, 1);
  const carryRelease = clamp(input.carryRelease, 0, 1);
  const riskGain = clamp(input.riskGain, 0, 4);
  const hazards = Array.from({ length: 7 }, (_, index) => clamp(input.weekdayHazards[index] ?? DEFAULT_WEEKDAY_HAZARDS[index], 0, 1));

  if (cycleAge >= 5 || input.advanceNotice) return { target: balance, safetyCap: balance };

  const mechanical = Math.min(balance, scheduleFromFloor(input.floor)[cycleAge]);
  const adaptive = adaptiveTarget({
    ...input,
    balance,
    cycleAge,
    weekday,
    nextResetHazard,
    carryRelease,
    riskGain,
    weekdayHazards: hazards,
  });
  const target = (1 - carryRelease) * mechanical + carryRelease * adaptive;
  const reliability = FORGET_PROBABILITY.map((value) => 1 - value);
  const futureReliability = reliability
    .slice(1, 7 - cycleAge)
    .reduce((sum, _, offset) => sum + reliability[(weekday + offset + 1) % 7], 0);
  const overuseMargin = clamp(REMEMBERED_MULTIPLIER_MEAN[weekday] - 1, 0, 0.08);
  const absoluteCap = DAILY_CAPACITY[weekday] * (1 + overuseMargin);
  const reserve = clamp(input.floor, 0, 1 / 7) * futureReliability;
  const safetyCap = Math.min(balance, absoluteCap, Math.max(balance - reserve, 0));
  return { target: Math.min(target, safetyCap), safetyCap };
}

function productiveOutputFraction(amount: number, fatigueKneePercent: number): number {
  return amount * smoothKneeEfficiency(amount * 100, fatigueKneePercent);
}

/**
 * Compute the maximum productive output obtainable from each remaining quota
 * balance over a fixed number of future days. This is the local TypeScript
 * port of T009's `future_value_table`; the grid is deliberately finite so it
 * stays deterministic and cheap enough to run on every quota refresh.
 */
function futureValueTable(
  fatigueKneePercent: number,
  futureDays: number,
  quotaSteps = MODEL_QUOTA_STEPS,
): { quotaGrid: number[]; production: number[]; value: number[] } {
  const quotaGrid = Array.from({ length: quotaSteps + 1 }, (_, index) => index / quotaSteps);
  const production = quotaGrid.map((amount) => productiveOutputFraction(amount, fatigueKneePercent));
  let value = [...production];
  for (let day = 2; day <= futureDays; day += 1) {
    const nextValue = new Array<number>(quotaSteps + 1);
    for (let balanceIndex = 0; balanceIndex <= quotaSteps; balanceIndex += 1) {
      let best = Number.NEGATIVE_INFINITY;
      for (let amountIndex = 0; amountIndex <= balanceIndex; amountIndex += 1) {
        best = Math.max(best, production[amountIndex] + value[balanceIndex - amountIndex]);
      }
      nextValue[balanceIndex] = best;
    }
    value = nextValue;
  }
  return { quotaGrid, production, value };
}

function futureDaysForCycleAge(cycleAge: number): number {
  // T009's reference heatmap is a six-day horizon: today plus five future
  // days. As a cycle advances, reduce only the available future horizon.
  return Math.trunc(clamp(DEFAULT_FUTURE_DAYS - Math.max(0, cycleAge - 1), 1, DEFAULT_FUTURE_DAYS));
}

/**
 * T009's fatigue-knee × reset-risk × carry policy.
 *
 * The heatmap's fresh target maximizes today's productive output plus the
 * expected value of the remaining quota when tomorrow does not reset. The
 * app generalizes the same calculation from a full quota to the live balance,
 * then releases 75% of yesterday's missed target as carry-in. All quantities
 * are percentages of the official quota window; no token conversion occurs.
 */
export function recommendFatigueAwareToday(input: FatigueAwareRecommendationInput): FatigueAwareRecommendation {
  const balance = clamp(finiteOr(input.balance, 0), 0, 1);
  const cycleAge = Math.trunc(clamp(finiteOr(input.cycleAge, 0), 0, 6));
  const risk = clamp(finiteOr(input.nextResetHazard, 0), 0, 1);
  const fatigueKneePercent = clamp(finiteOr(input.fatigueKneePercent, DEFAULT_SMOOTH_KNEE_PERCENT), 0.1, 100);
  const carryRelease = clamp(finiteOr(input.carryRelease, DEFAULT_CARRY_RELEASE), 0, 1);
  const carryIn = Math.min(balance, clamp(finiteOr(input.carryIn, 0), 0, 1));
  const futureDays = Math.trunc(clamp(finiteOr(input.futureDays, futureDaysForCycleAge(cycleAge)), 1, DEFAULT_FUTURE_DAYS));

  if (cycleAge >= 5 || input.advanceNotice || balance <= 0) {
    return { target: balance, safetyCap: balance, freshTarget: balance, carryIn, futureDays };
  }

  const { quotaGrid, production, value } = futureValueTable(fatigueKneePercent, futureDays);
  const balanceIndex = Math.min(MODEL_QUOTA_STEPS, Math.max(0, Math.round(balance * MODEL_QUOTA_STEPS)));
  const expectedFuture = value.slice(0, balanceIndex + 1).reverse().map((futureValue) => (1 - risk) * futureValue);
  const scores = production.slice(0, balanceIndex + 1).map((todayOutput, amountIndex) => (
    todayOutput + expectedFuture[amountIndex]
  ));
  const bestScore = Math.max(...scores);
  const tied = scores
    .map((score, index) => ({ score, index }))
    .filter(({ score }) => Math.abs(score - bestScore) <= 1e-10)
    .map(({ index }) => index);
  const equalShare = 1 / (futureDays + 1);
  const targetIndex = tied.reduce((best, index) => (
    Math.abs(quotaGrid[index] - equalShare) < Math.abs(quotaGrid[best] - equalShare) ? index : best
  ), tied[0] ?? 0);
  const freshTarget = quotaGrid[targetIndex];
  const target = Math.min(balance, freshTarget + carryRelease * carryIn);
  // The live weekly balance is the hard cap. The older behavior-aware policy
  // remains exported for compatibility, but must not cap the T009 heatmap
  // recommendation back to its old weekday capacity.
  return { target, safetyCap: balance, freshTarget, carryIn, futureDays };
}

type CarryUsage = Pick<CodexDailyUsage, "localDate" | "observedUsedPercent" | "sampleCount"> | Pick<DailyUsageSummary, "localDate" | "observedUsedPercent" | "sampleCount">;

/** Estimate yesterday's unspent recommendation from persisted local records. */
export function estimateCarryInPercent(
  recommendations: readonly DailyRecommendationRecord[],
  usage: readonly CarryUsage[],
  now = new Date(),
): number {
  const yesterday = usageDateKey(new Date(now.getTime() - DAY_MS));
  const previous = recommendations.find((item) => item.provider === "codex" && item.localDate === yesterday);
  const observed = usage.find((item) => item.localDate === yesterday && item.sampleCount > 0);
  if (!previous || !observed || !Number.isFinite(previous.targetPercent) || !Number.isFinite(observed.observedUsedPercent)) return 0;
  return roundPercent(clamp(previous.targetPercent - observed.observedUsedPercent, 0, 100));
}

function sameRecommendation(left: DailyRecommendationRecord, right: DailyRecommendationRecord): boolean {
  return left.provider === right.provider
    && left.localDate === right.localDate
    && left.targetPercent === right.targetPercent
    && left.safetyCapPercent === right.safetyCapPercent
    && left.resetRiskPercent === right.resetRiskPercent
    && left.fatigueKneePercent === right.fatigueKneePercent
    && left.carryInPercent === right.carryInPercent
    && left.policyVersion === right.policyVersion;
}

export function upsertDailyRecommendation(
  records: DailyRecommendationRecord[],
  record: DailyRecommendationRecord,
): DailyRecommendationRecord[] {
  const existing = records.find((item) => item.provider === record.provider && item.localDate === record.localDate);
  if (existing && sameRecommendation(existing, record)) return records;
  return [...records.filter((item) => item.provider !== record.provider || item.localDate !== record.localDate), record]
    .sort((left, right) => left.localDate.localeCompare(right.localDate) || left.provider.localeCompare(right.provider))
    .slice(-MAX_DAILY_RECOMMENDATIONS);
}

function usageWeekday(date: Date): number {
  const dateKey = usageDateKey(date);
  const [year, month, day] = dateKey.split("-").map(Number);
  const sundayBased = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return (sundayBased + 6) % 7;
}

function usageDayOrdinal(date: Date): number {
  const [year, month, day] = usageDateKey(date).split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function cycleAgeFor(baseline: DailyPaceBaseline | null | undefined, window: UsageWindow, now: Date): number {
  const candidate = baseline?.cycleStartedAt && Number.isFinite(Date.parse(baseline.cycleStartedAt))
    ? new Date(baseline.cycleStartedAt)
    : window.resetsAt && Number.isFinite(Date.parse(window.resetsAt))
      ? new Date(Date.parse(window.resetsAt) - Math.max(1, window.windowSeconds) * 1000)
      : null;
  if (!candidate) return 0;
  return Math.trunc(clamp(usageDayOrdinal(now) - usageDayOrdinal(candidate), 0, 6));
}

/** Blend public reset dates with the T009 Tuesday/Saturday prior. */
export function weekdayHazardsFromHistory(forecast: ResetForecast | null | undefined): number[] {
  const dates = forecast?.historyResetDates?.filter((value) => Number.isFinite(Date.parse(value))) ?? [];
  if (dates.length < 5) return [...DEFAULT_WEEKDAY_HAZARDS];
  const counts = Array.from({ length: 7 }, () => 0);
  for (const value of dates) counts[usageWeekday(new Date(value))] += 1;
  const total = dates.length + 7;
  const risk = clamp(finiteOr(forecast?.tomorrowRiskPercent ?? forecast?.score, 10) / 100, 0.05, 0.8);
  return counts.map((count, index) => {
    const empirical = risk * 7 * (count + 1) / total;
    return clamp(0.55 * DEFAULT_WEEKDAY_HAZARDS[index] + 0.45 * empirical, 0.02, 0.95);
  });
}

export function buildDailyRecommendation({
  weeklyWindow,
  baseline = null,
  resetForecast = null,
  resetRiskOverridePercent,
  fatigueKneePercent = DEFAULT_SMOOTH_KNEE_PERCENT,
  carryInPercent: _carryInPercent = 0,
  todayUsedPercent = 0,
  now = new Date(),
}: {
  weeklyWindow: UsageWindow | null;
  baseline?: DailyPaceBaseline | null;
  resetForecast?: ResetForecast | null;
  resetRiskOverridePercent?: number | null;
  fatigueKneePercent?: number;
  carryInPercent?: number;
  todayUsedPercent?: number;
  now?: Date;
}): DailyRecommendation | null {
  if (!weeklyWindow || !Number.isFinite(weeklyWindow.remainingPercent)) return null;
  const resetMs = Date.parse(weeklyWindow.resetsAt ?? "");
  if (!Number.isFinite(resetMs) || resetMs <= now.getTime()) return null;
  const remainingPercent = clamp(weeklyWindow.remainingPercent, 0, 100);
  const resetRiskPercent = clamp(finiteOr(resetRiskOverridePercent ?? resetForecast?.tomorrowRiskPercent ?? resetForecast?.score, 10), 0, 100);
  const historySampleCount = resetForecast?.historyResetDates?.length ?? resetForecast?.historySampleCount ?? 0;
  const cycleAge = cycleAgeFor(baseline, weeklyWindow, now);
  const weekday = usageWeekday(now);
  const daysLeftInCycle = (resetMs - now.getTime()) / DAY_MS;
  const todayFractionRemaining = clamp((endOfUsageDay(now) - now.getTime()) / DAY_MS, 0, 1);
  const used = clamp(finiteOr(todayUsedPercent, 0), 0, 100 - remainingPercent);
  const effectiveRisk = resetRiskOverridePercent == null && resetForecast?.resetAnnounced ? 100 : resetRiskPercent;
  const result = planRemainingQuota({
    remainingPercent,
    tomorrowRiskPercent: effectiveRisk,
    fatigueKneePercent,
    daysUntilReset: daysLeftInCycle,
    todayUsedPercent: used,
    todayFractionRemaining,
    isWeekend: weekday >= 5,
  });
  return {
    targetPercent: roundPercent(used + result.suggestedUsagePercent),
    safetyCapPercent: roundPercent(used + result.softCapPercent),
    additionalUsagePercent: result.suggestedUsagePercent,
    todayUsedPercent: used,
    todayFractionRemaining,
    resetRiskPercent: roundPercent(effectiveRisk),
    fatigueKneePercent: roundPercent(fatigueKneePercent),
    carryInPercent: 0,
    futureDays: daysLeftInCycle,
    cycleAge,
    weekday,
    historySampleCount,
    source: historySampleCount >= 5 ? "remote-history" : resetForecast ? "remote-model" : "local-fallback",
    policyVersion: DYNAMIC_POLICY_VERSION,
  };
}

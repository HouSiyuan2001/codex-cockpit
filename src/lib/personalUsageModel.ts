import type { CodexDailyUsage, DailyRecommendationRecord, DailyUsageSummary } from "../types";
import type { DailyRecommendation } from "./dynamicQuota";
import { smoothKneeEfficiency } from "./dynamicQuota";
import { usageDateKey } from "./usageDay";

export const PERSONAL_USAGE_POLICY_VERSION = "p014-t011-local-week-pattern-v1";
export const PERSONAL_USAGE_MIN_CALENDAR_DAYS = 21;
export const PERSONAL_USAGE_MIN_PLANNED_DAYS = 21;
export const PERSONAL_USAGE_MIN_ACTIVE_DAYS = 12;
export const PERSONAL_USAGE_HOLDOUT_DAYS = 7;

const DAY_MS = 86_400_000;
const MAX_STALE_DAYS = 3;
const MAX_ACTIVE_STALE_DAYS = 7;
const MIN_WEEKDAY_DAYS = 15;
const MIN_WEEKEND_DAYS = 6;
const PRIOR_WEIGHT = 4;
const MIN_HOLDOUT_GAIN = 0.01;
const MAX_GROUP_DRIFT = 0.45;
const GENERIC_REMEMBER_RATE = [0.98, 0.98, 0.98, 0.98, 0.97, 0.72, 0.62] as const;
const GENERIC_REMEMBERED_MULTIPLIER = [1.05, 1.06, 1.06, 1.07, 1.15, 0.7, 0.55] as const;

type UsageObservation = Pick<CodexDailyUsage, "localDate" | "observedUsedPercent" | "sampleCount">
  & Partial<Pick<CodexDailyUsage, "coverage" | "lastObservedAt">>
  | Pick<DailyUsageSummary, "localDate" | "observedUsedPercent" | "sampleCount" | "updatedAt">;

export type PersonalUsageFallbackReason =
  | "none"
  | "insufficient-calendar-span"
  | "insufficient-planned-days"
  | "insufficient-active-days"
  | "insufficient-weekday-weekend-balance"
  | "stale-history"
  | "distribution-drift"
  | "no-holdout-gain";

export interface PersonalWeekdayStat {
  weekday: number;
  plannedDays: number;
  rememberedDays: number;
  rememberRate: number;
  meanUsedPercent: number;
  meanUtilization: number;
  overuseRate: number;
  meanOverusePercent: number;
  allocationWeight: number;
}

export interface PersonalUsageValidation {
  holdoutDays: number;
  genericMae: number;
  personalizedMae: number;
  holdoutGain: number;
  genericExpiredWaste: number;
  personalizedExpiredWaste: number;
  genericEffectiveOutput: number;
  personalizedEffectiveOutput: number;
}

export interface PersonalUsageCalibration {
  mode: "personalized" | "generic-fallback";
  reason: PersonalUsageFallbackReason;
  policyVersion: string;
  calendarSpanDays: number;
  plannedDays: number;
  activeDays: number;
  latestPlannedDate: string | null;
  latestActiveDate: string | null;
  weekdayStats: PersonalWeekdayStat[];
  validation: PersonalUsageValidation | null;
}

interface ModelDay {
  localDate: string;
  ordinal: number;
  weekday: number;
  targetPercent: number;
  observedUsedPercent: number;
  active: boolean;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function localDateOrdinal(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(timestamp) ? Math.floor(timestamp / DAY_MS) : null;
}

function weekdayFromOrdinal(ordinal: number): number {
  return (new Date(ordinal * DAY_MS).getUTCDay() + 6) % 7;
}

function genericRatio(weekday: number): number {
  return GENERIC_REMEMBER_RATE[weekday] * GENERIC_REMEMBERED_MULTIPLIER[weekday];
}

function observationQuality(value: UsageObservation): number {
  const coverage = "coverage" in value ? value.coverage : undefined;
  return (coverage === "complete" ? 30_000 : coverage === "partial" ? 20_000 : coverage === "unavailable" ? 0 : 10_000)
    + clamp(Math.trunc(value.sampleCount), 0, 9_999);
}

function normalizedUsage(observations: readonly UsageObservation[]): Map<string, UsageObservation> {
  const result = new Map<string, UsageObservation>();
  for (const value of observations) {
    if (localDateOrdinal(value.localDate) === null || !Number.isFinite(value.observedUsedPercent) || !Number.isFinite(value.sampleCount)) continue;
    const existing = result.get(value.localDate);
    if (!existing || observationQuality(value) > observationQuality(existing)) result.set(value.localDate, value);
  }
  return result;
}

function modelDays(
  observations: readonly UsageObservation[],
  recommendations: readonly DailyRecommendationRecord[],
  now: Date,
): ModelDay[] {
  const usage = normalizedUsage(observations);
  const todayOrdinal = localDateOrdinal(usageDateKey(now))!;
  const plans = new Map<string, DailyRecommendationRecord>();
  for (const plan of recommendations) {
    const ordinal = localDateOrdinal(plan.localDate);
    if (plan.provider !== "codex" || ordinal === null || ordinal >= todayOrdinal || !Number.isFinite(plan.targetPercent) || plan.targetPercent <= 0) continue;
    const existing = plans.get(plan.localDate);
    if (!existing || Date.parse(plan.updatedAt) > Date.parse(existing.updatedAt)) plans.set(plan.localDate, plan);
  }
  return [...plans.values()].map((plan) => {
    const ordinal = localDateOrdinal(plan.localDate)!;
    const observed = usage.get(plan.localDate);
    const active = Boolean(observed && observed.sampleCount > 0);
    return {
      localDate: plan.localDate,
      ordinal,
      weekday: weekdayFromOrdinal(ordinal),
      targetPercent: clamp(plan.targetPercent, 0.1, 100),
      observedUsedPercent: active ? clamp(observed!.observedUsedPercent, 0, 100) : 0,
      active,
    };
  }).sort((left, right) => left.ordinal - right.ordinal);
}

function emptyWeekdayStats(): PersonalWeekdayStat[] {
  return Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    plannedDays: 0,
    rememberedDays: 0,
    rememberRate: 0,
    meanUsedPercent: 0,
    meanUtilization: 0,
    overuseRate: 0,
    meanOverusePercent: 0,
    allocationWeight: round(genericRatio(weekday)),
  }));
}

function fitWeekdayStats(days: readonly ModelDay[]): PersonalWeekdayStat[] {
  return Array.from({ length: 7 }, (_, weekday) => {
    const group = days.filter((day) => day.weekday === weekday);
    const remembered = group.filter((day) => day.active && day.observedUsedPercent > 0.5);
    const ratios = group.map((day) => clamp(day.observedUsedPercent / day.targetPercent, 0, 2));
    const overuse = group.map((day) => Math.max(0, day.observedUsedPercent - day.targetPercent));
    const generic = genericRatio(weekday);
    const allocationWeight = (ratios.reduce((sum, value) => sum + value, 0) + PRIOR_WEIGHT * generic) / (group.length + PRIOR_WEIGHT);
    return {
      weekday,
      plannedDays: group.length,
      rememberedDays: remembered.length,
      rememberRate: round(group.length > 0 ? remembered.length / group.length : 0),
      meanUsedPercent: round(group.length > 0 ? group.reduce((sum, day) => sum + day.observedUsedPercent, 0) / group.length : 0),
      meanUtilization: round(group.length > 0 ? ratios.reduce((sum, value) => sum + value, 0) / group.length : 0),
      overuseRate: round(group.length > 0 ? overuse.filter((value) => value > 0).length / group.length : 0),
      meanOverusePercent: round(overuse.length > 0 ? overuse.reduce((sum, value) => sum + value, 0) / overuse.length : 0),
      allocationWeight: round(clamp(allocationWeight, 0.25, 1.75)),
    };
  });
}

function groupRatio(days: readonly ModelDay[], weekend: boolean): number {
  const group = days.filter((day) => (day.weekday >= 5) === weekend);
  return group.length > 0
    ? group.reduce((sum, day) => sum + clamp(day.observedUsedPercent / day.targetPercent, 0, 2), 0) / group.length
    : 0;
}

function validationMetrics(days: readonly ModelDay[], stats: readonly PersonalWeekdayStat[]): PersonalUsageValidation {
  const predictions = days.map((day) => ({
    actual: day.observedUsedPercent,
    generic: day.targetPercent * genericRatio(day.weekday),
    personal: day.targetPercent * (stats[day.weekday]?.allocationWeight ?? genericRatio(day.weekday)),
  }));
  const aggregate = (key: "generic" | "personal") => {
    const mae = predictions.reduce((sum, item) => sum + Math.abs(item[key] - item.actual), 0) / Math.max(1, predictions.length);
    const expiredWaste = predictions.reduce((sum, item) => sum + Math.max(0, item[key] - item.actual), 0) / Math.max(1, predictions.length);
    const effectiveOutput = predictions.reduce((sum, item) => {
      const realized = Math.min(item.actual, item[key]);
      return sum + realized * smoothKneeEfficiency(realized);
    }, 0) / Math.max(1, predictions.length);
    return { mae, expiredWaste, effectiveOutput };
  };
  const generic = aggregate("generic");
  const personal = aggregate("personal");
  return {
    holdoutDays: days.length,
    genericMae: round(generic.mae),
    personalizedMae: round(personal.mae),
    holdoutGain: round(generic.mae > 0 ? (generic.mae - personal.mae) / generic.mae : 0),
    genericExpiredWaste: round(generic.expiredWaste),
    personalizedExpiredWaste: round(personal.expiredWaste),
    genericEffectiveOutput: round(generic.effectiveOutput),
    personalizedEffectiveOutput: round(personal.effectiveOutput),
  };
}

function fallback(
  reason: PersonalUsageFallbackReason,
  days: readonly ModelDay[],
  stats: PersonalWeekdayStat[] = emptyWeekdayStats(),
  validation: PersonalUsageValidation | null = null,
): PersonalUsageCalibration {
  const latestPlanned = days.at(-1) ?? null;
  const latestActive = [...days].reverse().find((day) => day.active) ?? null;
  return {
    mode: "generic-fallback",
    reason,
    policyVersion: PERSONAL_USAGE_POLICY_VERSION,
    calendarSpanDays: days.length > 0 ? days.at(-1)!.ordinal - days[0].ordinal + 1 : 0,
    plannedDays: days.length,
    activeDays: days.filter((day) => day.active).length,
    latestPlannedDate: latestPlanned?.localDate ?? null,
    latestActiveDate: latestActive?.localDate ?? null,
    weekdayStats: stats,
    validation,
  };
}

export function calibratePersonalUsage(
  observations: readonly UsageObservation[],
  recommendations: readonly DailyRecommendationRecord[],
  now = new Date(),
): PersonalUsageCalibration {
  const days = modelDays(observations, recommendations, now);
  if (days.length === 0) return fallback("insufficient-planned-days", days);
  const provisionalStats = fitWeekdayStats(days);
  const span = days.at(-1)!.ordinal - days[0].ordinal + 1;
  if (span < PERSONAL_USAGE_MIN_CALENDAR_DAYS) return fallback("insufficient-calendar-span", days, provisionalStats);
  if (days.length < PERSONAL_USAGE_MIN_PLANNED_DAYS) return fallback("insufficient-planned-days", days, provisionalStats);
  if (days.filter((day) => day.active).length < PERSONAL_USAGE_MIN_ACTIVE_DAYS) return fallback("insufficient-active-days", days, provisionalStats);
  if (days.filter((day) => day.weekday < 5).length < MIN_WEEKDAY_DAYS || days.filter((day) => day.weekday >= 5).length < MIN_WEEKEND_DAYS) {
    return fallback("insufficient-weekday-weekend-balance", days, provisionalStats);
  }
  const todayOrdinal = localDateOrdinal(usageDateKey(now))!;
  const latestActive = [...days].reverse().find((day) => day.active);
  if (todayOrdinal - days.at(-1)!.ordinal > MAX_STALE_DAYS || !latestActive || todayOrdinal - latestActive.ordinal > MAX_ACTIVE_STALE_DAYS) {
    return fallback("stale-history", days, provisionalStats);
  }

  const holdout = days.slice(-PERSONAL_USAGE_HOLDOUT_DAYS);
  const training = days.slice(0, -PERSONAL_USAGE_HOLDOUT_DAYS);
  const stats = fitWeekdayStats(training);
  const validation = validationMetrics(holdout, stats);
  const weekdayDrift = Math.abs(groupRatio(training, false) - groupRatio(holdout, false));
  const weekendDrift = Math.abs(groupRatio(training, true) - groupRatio(holdout, true));
  if (Math.max(weekdayDrift, weekendDrift) > MAX_GROUP_DRIFT) return fallback("distribution-drift", days, stats, validation);
  if (validation.holdoutGain < MIN_HOLDOUT_GAIN) return fallback("no-holdout-gain", days, stats, validation);
  return {
    ...fallback("none", days, stats, validation),
    mode: "personalized",
  };
}

export function applyPersonalUsageCalibration(
  recommendation: DailyRecommendation,
  calibration: PersonalUsageCalibration,
): DailyRecommendation {
  if (calibration.mode !== "personalized" || recommendation.targetPercent >= recommendation.safetyCapPercent) return recommendation;
  const currentWeight = calibration.weekdayStats[recommendation.weekday]?.allocationWeight ?? 1;
  const horizonWeights = Array.from({ length: recommendation.futureDays + 1 }, (_, offset) => (
    calibration.weekdayStats[(recommendation.weekday + offset) % 7]?.allocationWeight ?? 1
  ));
  const horizonMean = horizonWeights.reduce((sum, value) => sum + value, 0) / Math.max(1, horizonWeights.length);
  const adjustment = clamp(currentWeight / Math.max(0.25, horizonMean), 0.7, 1.3);
  const confidence = clamp((calibration.validation?.holdoutGain ?? 0) * 2, 0.25, 0.65);
  const targetPercent = round(clamp(
    recommendation.targetPercent * (1 + confidence * (adjustment - 1)),
    0,
    recommendation.safetyCapPercent,
  ), 1);
  return {
    ...recommendation,
    targetPercent,
    policyVersion: `${recommendation.policyVersion}+${PERSONAL_USAGE_POLICY_VERSION}`,
  };
}

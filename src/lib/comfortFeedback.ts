import { MAX_DAILY_OBSERVED_PERCENT } from "../types";
import type { CodexDailyUsage, ComfortCode, ComfortCurveObservation, ComfortCurvePoint, ComfortFeedbackRecord, ComfortPrompt, ComfortQuotaAllocation, ComfortTokenModelUsage, ComfortTokenSnapshot, ComfortUsageCoverage, ComfortUsageSource, DailyUsageSummary, PersonalizedComfortCurve } from "../types";

export const COMFORT_REMINDER_HOUR = 22;
export const BASELINE_X_STAR_PERCENT = 25;
// Keep the persisted observation format readable by the previous app on rollback.
export const COMFORT_CURVE_VERSION = "p014-t014-ordinal-map-v3";
export const COMFORT_FIT_VERSION = "p020-fixed-score-k-v6";
export const COMFORT_FEEDBACK_HALF_LIFE_DAYS = 14;
const LEGACY_COMFORT_CURVE_VERSIONS = new Set(["p014-t014-smooth-knee-v2", "p014-t014-y-v1"]);

export const MAX_COMFORT_FEEDBACK_RECORDS_PER_PERSON = 90;
export const MAX_COMFORT_PERSONS = 32;
const MAX_COMFORT_PROMPTS_PER_PERSON = 90;
const MAX_TOKEN_MODELS = 128;
const MAX_TOKEN_DEVICES = 64;
const MAX_ALLOCATION_DEVICES = 128;
const NORMALIZATION_FUTURE_TOLERANCE_MS = 300_000;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function localDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromLocalDate(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function validLocalDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = dateFromLocalDate(value);
  return localDateKey(parsed) === value;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isComfortCode(value: unknown): value is ComfortCode {
  return value === "overloaded" || value === "comfortable" || value === "idle";
}

function isCoverage(value: unknown): value is ComfortUsageCoverage {
  return value === "complete" || value === "partial" || value === "unavailable";
}

function isSource(value: unknown): value is ComfortUsageSource {
  return value === "official-snapshot" || value === "local-history" || value === "unavailable";
}

function normalizePersonId(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined;
}

function normalizePersonName(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 64 ? normalized : null;
}

function normalizeTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeTokenModel(value: unknown): ComfortTokenModelUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<ComfortTokenModelUsage>;
  if (typeof candidate.id !== "string" || candidate.id.length === 0 || candidate.id.length > 128
    || typeof candidate.name !== "string" || candidate.name.length === 0 || candidate.name.length > 128) return null;
  const inputTokens = normalizeTokenCount(candidate.inputTokens);
  const cachedInputTokens = normalizeTokenCount(candidate.cachedInputTokens);
  const outputTokens = normalizeTokenCount(candidate.outputTokens);
  const reasoningTokens = normalizeTokenCount(candidate.reasoningTokens);
  if (inputTokens === null || cachedInputTokens === null || outputTokens === null || reasoningTokens === null) return null;
  const totalTokens = inputTokens + cachedInputTokens + outputTokens;
  if (!Number.isSafeInteger(totalTokens)) return null;
  return { id: candidate.id, name: candidate.name, inputTokens, cachedInputTokens, outputTokens, reasoningTokens, totalTokens };
}

function normalizeDeviceIds(value: unknown, maximum = MAX_TOKEN_DEVICES): string[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > 128 || /[\u0000-\u001f\u007f]/.test(item)) return null;
    if (!result.includes(item)) result.push(item);
  }
  return result;
}

function normalizeNullableNumber(value: unknown, minimum: number, maximum: number): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum ? value : undefined;
}

export function normalizeComfortQuotaAllocation(
  value: unknown,
  recordDate?: string,
  sharedTotalUsedPercent?: number | null,
): ComfortQuotaAllocation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<ComfortQuotaAllocation>;
  if (candidate.metricVersion !== "cost-share-v1" || !validLocalDate(candidate.localDate)
    || candidate.localDate > localDateKey(new Date())
    || (recordDate !== undefined && candidate.localDate !== recordDate) || !validTimestamp(candidate.observedAt)
    || Date.parse(candidate.observedAt) > Date.now() + NORMALIZATION_FUTURE_TOLERANCE_MS || !isCoverage(candidate.coverage)) return null;
  const candidateTotal = normalizeNullableNumber(candidate.totalUsedPercent, 0, MAX_DAILY_OBSERVED_PERCENT);
  const personCost = normalizeNullableNumber(candidate.personCostUsd, 0, 1_000_000_000);
  const totalCost = normalizeNullableNumber(candidate.totalCostUsd, 0, 1_000_000_000);
  const candidateShare = normalizeNullableNumber(candidate.costShare, 0, 1);
  const candidateAllocated = normalizeNullableNumber(candidate.allocatedUsedPercent, 0, MAX_DAILY_OBSERVED_PERCENT);
  const deviceIds = normalizeDeviceIds(candidate.deviceIds, MAX_ALLOCATION_DEVICES);
  const missingDeviceIds = normalizeDeviceIds(candidate.missingDeviceIds, MAX_ALLOCATION_DEVICES);
  if (candidateTotal === undefined || personCost === undefined || totalCost === undefined || candidateShare === undefined
    || candidateAllocated === undefined || deviceIds === null || missingDeviceIds === null) return null;
  const recordTotal = sharedTotalUsedPercent === undefined || sharedTotalUsedPercent === null
    ? candidateTotal
    : normalizeNullableNumber(sharedTotalUsedPercent, 0, MAX_DAILY_OBSERVED_PERCENT);
  if (recordTotal === undefined || (personCost !== null && (totalCost === null || totalCost <= 0 || personCost > totalCost + 1e-9))) return null;
  const costShare = personCost !== null && totalCost !== null && totalCost > 0
    ? round(clamp(personCost / totalCost, 0, 1), 8)
    : null;
  const allocatedUsedPercent = recordTotal !== null && costShare !== null
    ? round(clamp(recordTotal * costShare, 0, recordTotal), 4)
    : null;
  const coverage = candidate.coverage === "complete" && (costShare === null || allocatedUsedPercent === null || missingDeviceIds.length > 0)
    ? "partial"
    : candidate.coverage;
  return {
    metricVersion: "cost-share-v1",
    localDate: candidate.localDate,
    observedAt: candidate.observedAt,
    totalUsedPercent: recordTotal,
    personCostUsd: coverage === "unavailable" ? null : personCost,
    totalCostUsd: coverage === "unavailable" ? null : totalCost,
    costShare: coverage === "unavailable" ? null : costShare,
    allocatedUsedPercent: coverage === "unavailable" ? null : allocatedUsedPercent,
    coverage,
    deviceIds,
    missingDeviceIds,
  };
}

export function normalizeComfortTokenSnapshot(value: unknown, recordDate?: string): ComfortTokenSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<ComfortTokenSnapshot>;
  if (!validLocalDate(candidate.localDate) || (recordDate !== undefined && candidate.localDate !== recordDate)
    || !validTimestamp(candidate.observedAt) || !isCoverage(candidate.coverage)
    || typeof candidate.metricVersion !== "string" || candidate.metricVersion.length === 0 || candidate.metricVersion.length > 120
    || !Array.isArray(candidate.models) || candidate.models.length > MAX_TOKEN_MODELS) return null;
  const inputTokens = normalizeTokenCount(candidate.inputTokens);
  const cachedInputTokens = normalizeTokenCount(candidate.cachedInputTokens);
  const outputTokens = normalizeTokenCount(candidate.outputTokens);
  const reasoningTokens = normalizeTokenCount(candidate.reasoningTokens);
  const models = candidate.models.map(normalizeTokenModel);
  const deviceIds = normalizeDeviceIds(candidate.deviceIds);
  const missingDeviceIds = normalizeDeviceIds(candidate.missingDeviceIds);
  const incompleteDeviceIds = normalizeDeviceIds(candidate.incompleteDeviceIds ?? []);
  if (inputTokens === null || cachedInputTokens === null || outputTokens === null || reasoningTokens === null
    || models.some((model) => model === null) || deviceIds === null || missingDeviceIds === null || incompleteDeviceIds === null) return null;
  const totalTokens = inputTokens + cachedInputTokens + outputTokens;
  if (!Number.isSafeInteger(totalTokens)) return null;
  return {
    localDate: candidate.localDate,
    observedAt: candidate.observedAt,
    metricVersion: candidate.metricVersion,
    coverage: candidate.coverage,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    models: models as ComfortTokenModelUsage[],
    deviceIds,
    missingDeviceIds,
    incompleteDeviceIds,
  };
}

export function normalizeComfortFeedbackRecord(value: unknown): ComfortFeedbackRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<ComfortFeedbackRecord>;
  if (!validLocalDate(candidate.localDate) || !validTimestamp(candidate.observedAt) || !isComfortCode(candidate.comfort)
    || !isCoverage(candidate.usageCoverage) || !isSource(candidate.usageSource)
    || (candidate.curveVersion !== COMFORT_CURVE_VERSION && !LEGACY_COMFORT_CURVE_VERSIONS.has(candidate.curveVersion ?? ""))) return null;
  if (candidate.usageObservedAt !== null && candidate.usageObservedAt !== undefined && !validTimestamp(candidate.usageObservedAt)) return null;
  const used = candidate.observedUsedPercent;
  if (used !== null && (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > MAX_DAILY_OBSERVED_PERCENT)) return null;
  const personId = normalizePersonId(candidate.personId);
  if (personId === undefined) return null;
  const tokenSnapshot = candidate.tokenSnapshot === null || candidate.tokenSnapshot === undefined
    ? null
    : normalizeComfortTokenSnapshot(candidate.tokenSnapshot, candidate.localDate);
  if (candidate.tokenSnapshot !== null && candidate.tokenSnapshot !== undefined && tokenSnapshot === null) return null;
  const quotaAllocation = candidate.quotaAllocation === null || candidate.quotaAllocation === undefined
    ? null
    : normalizeComfortQuotaAllocation(candidate.quotaAllocation, candidate.localDate, used ?? null);
  return {
    localDate: candidate.localDate,
    observedAt: candidate.observedAt,
    comfort: candidate.comfort,
    ...(validTimestamp(candidate.updatedAt) ? { updatedAt: candidate.updatedAt } : {}),
    personId,
    personName: normalizePersonName(candidate.personName),
    tokenSnapshot,
    quotaAllocation,
    observedUsedPercent: used,
    usageObservedAt: candidate.usageObservedAt ?? null,
    usageCoverage: candidate.usageCoverage,
    usageSource: candidate.usageSource,
    curveVersion: COMFORT_CURVE_VERSION,
  };
}

function samePerson(left: string | null | undefined, right: string | null | undefined): boolean {
  return (left ?? null) === (right ?? null);
}

function feedbackIdentity(record: Pick<ComfortFeedbackRecord, "personId" | "localDate">): string {
  return `${record.personId === null || record.personId === undefined ? "legacy" : `person:${encodeURIComponent(record.personId)}`}|${record.localDate}`;
}

/** Normalize, deduplicate by person+calendar date, and bound each person independently. */
export function normalizeComfortFeedbackRecords(value: unknown): ComfortFeedbackRecord[] {
  if (!Array.isArray(value)) return [];
  const deduplicated = new Map<string, { record: ComfortFeedbackRecord; index: number }>();
  value.forEach((item, index) => {
    const normalized = normalizeComfortFeedbackRecord(item);
    if (!normalized) return;
    const key = feedbackIdentity(normalized);
    const previous = deduplicated.get(key);
    if (!previous || Date.parse(normalized.updatedAt ?? normalized.observedAt) >= Date.parse(previous.record.updatedAt ?? previous.record.observedAt)) {
      deduplicated.set(key, { record: normalized, index });
    }
  });
  const buckets = new Map<string | null, Array<{ record: ComfortFeedbackRecord; index: number }>>();
  for (const item of deduplicated.values()) {
    const key = item.record.personId ?? null;
    const bucket = buckets.get(key) ?? [];
    bucket.push(item);
    buckets.set(key, bucket);
  }
  const retainedPeople = [...buckets.entries()]
    .filter(([personId]) => personId !== null)
    .sort((left, right) => Math.max(...right[1].map(item => Date.parse(item.record.observedAt)))
      - Math.max(...left[1].map(item => Date.parse(item.record.observedAt)))
      || (left[0] ?? "").localeCompare(right[0] ?? ""))
    .slice(0, MAX_COMFORT_PERSONS)
    .map(([personId]) => personId);
  const retained = new Set<string | null>([null, ...retainedPeople]);
  return [...buckets.entries()]
    .filter(([personId]) => retained.has(personId))
    .flatMap(([, bucket]) => bucket
      .sort((left, right) => left.record.localDate.localeCompare(right.record.localDate) || left.index - right.index)
      .slice(-MAX_COMFORT_FEEDBACK_RECORDS_PER_PERSON))
    .sort((left, right) => left.index - right.index)
    .map(item => item.record);
}

export function getComfortPromptTarget(
  now = new Date(),
  records: readonly ComfortFeedbackRecord[] = [],
  promptedDates: readonly string[] = [],
  reminderHour = COMFORT_REMINDER_HOUR,
): { localDate: string; isCatchUp: boolean } | null {
  return getPersonComfortPromptTarget(null, now, records, promptedDates, reminderHour);
}

export function comfortReminderKey(personId: string | null, localDate: string): string | null {
  if (!validLocalDate(localDate)) return null;
  const normalizedPersonId = normalizePersonId(personId);
  if (normalizedPersonId === undefined) return null;
  return normalizedPersonId === null
    ? `legacy:${localDate}`
    : `person:${encodeURIComponent(normalizedPersonId)}:${localDate}`;
}

function isPromptedForPerson(promptedDates: readonly string[], personId: string | null, localDate: string): boolean {
  const key = comfortReminderKey(personId, localDate);
  return key !== null && (promptedDates.includes(key) || (personId === null && promptedDates.includes(localDate)));
}

export function getPersonComfortPromptTarget(
  personId: string | null,
  now = new Date(),
  records: readonly ComfortFeedbackRecord[] = [],
  promptedDates: readonly string[] = [],
  reminderHour = COMFORT_REMINDER_HOUR,
): { localDate: string; isCatchUp: boolean } | null {
  if (normalizePersonId(personId) === undefined) return null;
  const today = localDateKey(now);
  const target = new Date(now);
  const isTodayEligible = now.getHours() >= reminderHour;
  if (!isTodayEligible) target.setDate(target.getDate() - 1);
  const targetDate = localDateKey(target);
  if (records.some((record) => samePerson(record.personId, personId) && record.localDate === targetDate)
    || isPromptedForPerson(promptedDates, personId, targetDate)) return null;
  return { localDate: targetDate, isCatchUp: targetDate !== today };
}

export function nextComfortReminderAt(now = new Date(), reminderHour = COMFORT_REMINDER_HOUR): Date {
  const next = new Date(now);
  next.setHours(reminderHour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

export function selectComfortUsage(
  targetDate: string,
  official: CodexDailyUsage | null,
  localHistory: readonly DailyUsageSummary[] = [],
): Pick<ComfortPrompt, "observedUsedPercent" | "usageObservedAt" | "usageCoverage" | "usageSource"> {
  if (official && official.localDate === targetDate && official.coverage !== "unavailable" && Number.isFinite(official.observedUsedPercent) && official.observedUsedPercent >= 0 && official.observedUsedPercent <= MAX_DAILY_OBSERVED_PERCENT) {
    return {
      observedUsedPercent: official.observedUsedPercent,
      usageObservedAt: official.lastObservedAt,
      usageCoverage: official.coverage,
      usageSource: "official-snapshot",
    };
  }
  const local = localHistory.find((item) => item.provider === "codex" && item.localDate === targetDate && item.sampleCount > 0 && Number.isFinite(item.observedUsedPercent) && item.observedUsedPercent >= 0 && item.observedUsedPercent <= MAX_DAILY_OBSERVED_PERCENT);
  if (local) {
    return {
      observedUsedPercent: local.observedUsedPercent,
      usageObservedAt: local.updatedAt,
      usageCoverage: "partial",
      usageSource: "local-history",
    };
  }
  return { observedUsedPercent: null, usageObservedAt: null, usageCoverage: "unavailable", usageSource: "unavailable" };
}

export function buildComfortPrompt(
  target: { localDate: string; isCatchUp: boolean },
  official: CodexDailyUsage | null,
  localHistory: readonly DailyUsageSummary[] = [],
): ComfortPrompt {
  return { ...target, ...selectComfortUsage(target.localDate, official, localHistory) };
}

export function createComfortFeedbackRecord(prompt: ComfortPrompt, comfort: ComfortCode, observedAt = new Date()): ComfortFeedbackRecord {
  return {
    localDate: prompt.localDate,
    observedAt: observedAt.toISOString(),
    comfort,
    personId: prompt.personId ?? null,
    personName: prompt.personName ?? null,
    tokenSnapshot: prompt.tokenSnapshot ?? null,
    quotaAllocation: prompt.quotaAllocation ?? null,
    observedUsedPercent: prompt.observedUsedPercent,
    usageObservedAt: prompt.usageObservedAt,
    usageCoverage: prompt.usageCoverage,
    usageSource: prompt.usageSource,
    curveVersion: COMFORT_CURVE_VERSION,
  };
}

/** Legacy T009 curve kept as a compatibility export for old local tests/data. */
export function comfortYield(usedPercent: number, xStarPercent = BASELINE_X_STAR_PERCENT): number {
  const x = clamp(usedPercent, 0, 100) / 100;
  const xStar = clamp(xStarPercent, 1, 100) / 100;
  if (x === 0) return 0;
  return (x / xStar) * Math.exp(1 - x / xStar);
}

/**
 * Latest T009 smooth-knee fatigue efficiency. x is a displayed daily quota
 * percentage, never a token or account value. Productive output is x times
 * this efficiency; the curve itself is normalized to peak efficiency 1.
 */
export function smoothKneeEfficiency(usedPercent: number, xStarPercent = BASELINE_X_STAR_PERCENT): number {
  if (!Number.isFinite(usedPercent) || usedPercent < 0) return 0;
  const knee = clamp(xStarPercent, 0.1, 100) / 100;
  // Keep the established 0–100% family and its 20% lower bound beyond 100%.
  const value = usedPercent / 100;
  const tau = 0.02;
  const power = 1.5;
  const sharpness = 4.3;
  const softplus = (input: number) => input > 30 ? input : Math.log1p(Math.exp(input));
  const shoulder = (input: number) => tau * softplus((input - knee) / tau);
  const response = (input: number) => Math.exp(-sharpness * input ** power);
  const low = response(shoulder(0));
  const high = response(shoulder(1));
  if (Math.abs(low - high) < 1e-12) return 0.2;
  const result = 0.2 + 0.8 * (response(shoulder(value)) - high) / (low - high);
  return clamp(result, 0.2, 1);
}

function curvePoints(xStarPercent: number, count = 101): ComfortCurvePoint[] {
  return Array.from({ length: count }, (_, index) => {
    const usedPercent = (index / (count - 1)) * 100;
    return {
      usedPercent,
      baselineScore: round(smoothKneeEfficiency(usedPercent, BASELINE_X_STAR_PERCENT), 4),
      personalizedScore: round(smoothKneeEfficiency(usedPercent, xStarPercent), 4),
    };
  });
}

const FIT_MIN_X_STAR = 0.1;
const FIT_MAX_X_STAR = 100;
const FIT_X_STEP = 0.1;
// Fixed residual scale is used only for the existing heuristic confidence.
const FIT_SCORE_SIGMA = 0.15;

/** User-defined score, not a model prediction or measured efficiency. */
export function comfortFeedbackScore(comfort: ComfortCode): number {
  return comfort === "idle" ? 1 : comfort === "comfortable" ? 0.8 : 0.25;
}

/** Age the experience date, not the edit timestamp. Calendar-day arithmetic
 * avoids DST artifacts; future/invalid experiences never train today's fit. */
export function comfortFeedbackWeight(record: ComfortFeedbackRecord, now = new Date()): number {
  if (!validLocalDate(record.localDate) || !Number.isFinite(now.getTime()) || record.usageCoverage === "unavailable") return 0;
  const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
  const ageDays = dayNumber(localDateKey(now)) - dayNumber(record.localDate);
  if (ageDays < 0) return 0;
  const coverageWeight = record.usageCoverage === "complete" ? 1 : 0.75;
  return coverageWeight * 2 ** (-ageDays / COMFORT_FEEDBACK_HALF_LIFE_DAYS);
}

interface WeightedFeedback { record: Pick<ComfortFeedbackRecord, "observedUsedPercent" | "comfort">; weight: number }

function usableFeedbackRecords(records: readonly ComfortFeedbackRecord[]): ComfortFeedbackRecord[] {
  return records.filter((record) => record.observedUsedPercent !== null
    && Number.isFinite(record.observedUsedPercent)
    && record.observedUsedPercent >= 0 && record.observedUsedPercent <= MAX_DAILY_OBSERVED_PERCENT
    && record.usageCoverage !== "unavailable");
}

function buildCurveObservations(records: readonly { record: ComfortFeedbackRecord; weight: number }[]): ComfortCurveObservation[] {
  return records.map(({ record, weight }) => ({
    localDate: record.localDate,
    usedPercent: round(record.observedUsedPercent ?? 0, 2),
    comfort: record.comfort,
    usageCoverage: record.usageCoverage as Exclude<ComfortUsageCoverage, "unavailable">,
    fitWeight: weight,
  }));
}

function fitXStar(observations: readonly WeightedFeedback[]): { xStarPercent: number; confidence: number } {
  const profile: Array<{ xStarPercent: number; score: number }> = [];
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestXStar = BASELINE_X_STAR_PERCENT;
  const steps = Math.round((FIT_MAX_X_STAR - FIT_MIN_X_STAR) / FIT_X_STEP);
  for (let index = 0; index <= steps; index++) {
    const xStar = round(FIT_MIN_X_STAR + index * FIT_X_STEP, 1);
    // Fit the actual plotted scores by weighted least squares. Only k varies.
    const squaredError = observations.reduce((sum, { record, weight }) => {
      const residual = smoothKneeEfficiency(record.observedUsedPercent ?? 0, xStar) - comfortFeedbackScore(record.comfort);
      return sum + weight * residual ** 2;
    }, 0);
    const profileScore = -squaredError / (2 * FIT_SCORE_SIGMA ** 2);
    profile.push({ xStarPercent: xStar, score: profileScore });
    if (profileScore > bestScore + 1e-10 || (Math.abs(profileScore - bestScore) <= 1e-10 && Math.abs(xStar - BASELINE_X_STAR_PERCENT) < Math.abs(bestXStar - BASELINE_X_STAR_PERCENT))) {
      bestScore = profileScore;
      bestXStar = xStar;
    }
  }

  const weights = profile.map(({ score }) => Math.exp(score - bestScore));
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  const posteriorMean = profile.reduce((total, item, index) => total + item.xStarPercent * weights[index], 0) / totalWeight;
  const posteriorVariance = profile.reduce((total, item, index) => total + ((item.xStarPercent - posteriorMean) ** 2) * weights[index], 0) / totalWeight;
  const posteriorSigma = Math.sqrt(posteriorVariance);
  const weightedSampleCount = observations.reduce((total, item) => total + item.weight, 0);
  const dataConfidence = Math.min(0.75, weightedSampleCount / 5 * 0.75);
  const concentration = clamp(1 - posteriorSigma / 24, 0.2, 1);
  const confidence = round(dataConfidence * concentration, 3);
  return {
    xStarPercent: bestXStar,
    confidence,
  };
}

export function personalizeComfortCurve(
  records: readonly ComfortFeedbackRecord[] = [],
  now = new Date(),
  personId?: string | null,
): PersonalizedComfortCurve {
  const identities = new Set(records.map(record => record.personId ?? null));
  // An omitted identity is backwards-compatible only for a single-person set.
  // Mixed people must never train the quota-percent planner as one person.
  const personRecords = personId !== undefined
    ? records.filter(record => samePerson(record.personId, personId))
    : identities.size <= 1 ? records : [];
  // Compute weights once, rather than parsing dates inside every grid candidate.
  const usable = usableFeedbackRecords(personRecords)
    .map(record => ({ record, weight: comfortFeedbackWeight(record, now) }))
    .filter(item => item.weight > 0);
  const observations = buildCurveObservations(usable);
  const sampleCount = observations.length;
  const weighting = {
    recencyHalfLifeDays: COMFORT_FEEDBACK_HALF_LIFE_DAYS,
    weightedSampleCount: round(usable.reduce((total, item) => total + item.weight, 0), 2),
  };
  if (sampleCount === 0) {
    return {
      curveVersion: COMFORT_FIT_VERSION,
      baselineXStarPercent: BASELINE_X_STAR_PERCENT,
      xStarPercent: BASELINE_X_STAR_PERCENT,
      sampleCount: 0,
      confidence: 0,
      mode: "baseline-fallback",
      points: curvePoints(BASELINE_X_STAR_PERCENT),
      observations,
      ...weighting,
    };
  }
  const fit = fitXStar(usable);
  return {
    curveVersion: COMFORT_FIT_VERSION,
    baselineXStarPercent: BASELINE_X_STAR_PERCENT,
    xStarPercent: fit.xStarPercent,
    sampleCount,
    confidence: fit.confidence,
    mode: "personalized",
    points: curvePoints(fit.xStarPercent),
    observations,
    ...weighting,
  };
}

export function appendComfortFeedback(
  records: readonly ComfortFeedbackRecord[],
  record: ComfortFeedbackRecord,
): ComfortFeedbackRecord[] {
  const normalized = normalizeComfortFeedbackRecord(record);
  if (!normalized) return normalizeComfortFeedbackRecords(records);
  return normalizeComfortFeedbackRecords([
    ...records.filter((item) => !(samePerson(item.personId, normalized.personId) && item.localDate === normalized.localDate)),
    normalized,
  ]);
}

export function upsertComfortFeedbackRecord(
  records: readonly ComfortFeedbackRecord[],
  localDate: string,
  comfort: ComfortCode,
  observedAt = new Date(),
  personId: string | null = null,
): ComfortFeedbackRecord[] {
  if (!validLocalDate(localDate) || !isComfortCode(comfort) || !Number.isFinite(observedAt.getTime())
    || normalizePersonId(personId) === undefined) return [...records];
  const existing = records.find((item) => samePerson(item.personId, personId) && item.localDate === localDate);
  const record: ComfortFeedbackRecord = existing
    ? { ...existing, comfort, observedAt: observedAt.toISOString(), curveVersion: COMFORT_CURVE_VERSION }
    : {
        localDate,
        observedAt: observedAt.toISOString(),
        comfort,
        personId,
        personName: null,
        tokenSnapshot: null,
        observedUsedPercent: null,
        usageObservedAt: null,
        usageCoverage: "unavailable",
        usageSource: "unavailable",
        curveVersion: COMFORT_CURVE_VERSION,
      };
  return appendComfortFeedback(records, record);
}

function parseComfortReminderKey(value: unknown): { personId: string | null; localDate: string } | null {
  if (typeof value !== "string") return null;
  if (validLocalDate(value)) return { personId: null, localDate: value };
  const legacy = /^legacy:(\d{4}-\d{2}-\d{2})$/.exec(value);
  if (legacy && validLocalDate(legacy[1])) return { personId: null, localDate: legacy[1] };
  const assigned = /^person:([^:]+):(\d{4}-\d{2}-\d{2})$/.exec(value);
  if (!assigned || !validLocalDate(assigned[2])) return null;
  try {
    const personId = decodeURIComponent(assigned[1]);
    return normalizePersonId(personId) === undefined ? null : { personId, localDate: assigned[2] };
  } catch {
    return null;
  }
}

export function normalizeComfortPromptedKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const byPerson = new Map<string | null, string[]>();
  for (const item of value) {
    const parsed = parseComfortReminderKey(item);
    if (!parsed) continue;
    const key = comfortReminderKey(parsed.personId, parsed.localDate);
    if (!key) continue;
    const bucket = byPerson.get(parsed.personId) ?? [];
    if (!bucket.includes(key)) bucket.push(key);
    byPerson.set(parsed.personId, bucket);
  }
  const assignedPeople = [...byPerson.keys()].filter((personId): personId is string => personId !== null).slice(-MAX_COMFORT_PERSONS);
  const retained = new Set<string | null>([null, ...assignedPeople]);
  return [...byPerson.entries()]
    .filter(([personId]) => retained.has(personId))
    .flatMap(([, keys]) => keys.slice(-MAX_COMFORT_PROMPTS_PER_PERSON));
}

export function appendComfortPromptedDate(dates: readonly string[], localDate: string, personId: string | null = null): string[] {
  const key = comfortReminderKey(personId, localDate);
  if (!key) return normalizeComfortPromptedKeys(dates);
  const current = normalizeComfortPromptedKeys(dates);
  return normalizeComfortPromptedKeys([...current, key]);
}

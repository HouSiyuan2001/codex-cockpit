import type {
  ComfortCode,
  ComfortFeedbackRecord,
  ComfortTokenModelUsage,
  ComfortTokenSnapshot,
  TokenComfortModel,
  TokenComfortObservation,
  TokenComfortTrendPoint,
} from "../types";
import type { DailyModelUsage, TokeiDevice, TokeiUsage, UsageMetrics } from "./tokeiUsage";

export const COMFORT_TOKEN_METRIC_VERSION = "p020-person-calendar-token-v1";
export const TOKEN_COMFORT_MODEL_VERSION = "p020-token-comfort-binned-v1";
export const TOKEN_COMFORT_MIN_COMPLETE_DAYS = 7;
export const TOKEN_COMFORT_MIN_DISTINCT_VALUES = 3;
export const TOKEN_COMFORT_MIN_RANGE_TOKENS = 100_000;

const MAX_SNAPSHOT_DEVICES = 64;
const MAX_SNAPSHOT_MODELS = 128;

type TokenCounts = Pick<UsageMetrics, "inputTokens" | "cachedInputTokens" | "outputTokens" | "reasoningTokens" | "totalTokens">;

const ZERO_TOKEN_COUNTS: TokenCounts = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
};

function validLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(year, month - 1, day, 12);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

function safeTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function addUsage(target: TokenCounts, source: Partial<TokenCounts>): void {
  target.inputTokens += safeTokenCount(source.inputTokens);
  target.cachedInputTokens += safeTokenCount(source.cachedInputTokens);
  target.outputTokens += safeTokenCount(source.outputTokens);
  target.reasoningTokens += safeTokenCount(source.reasoningTokens);
  target.totalTokens = target.inputTokens + target.cachedInputTokens + target.outputTokens;
}

function latestDevices(devices: readonly TokeiDevice[], wanted: ReadonlySet<string>): Map<string, TokeiDevice> {
  const result = new Map<string, TokeiDevice>();
  for (const device of devices) {
    if (!wanted.has(device.id)) continue;
    const previous = result.get(device.id);
    const updated = Date.parse(device.updatedAt ?? "") || 0;
    const previousUpdated = Date.parse(previous?.updatedAt ?? "") || 0;
    if (!previous || updated >= previousUpdated) result.set(device.id, device);
  }
  return result;
}

function dayEndTimestamp(localDate: string): number {
  const [year, month, day] = localDate.split("-").map(Number);
  return new Date(year, month - 1, day + 1, 0, 0, 0, 0).getTime();
}

function normalizedObservedAt(data: TokeiUsage, fallback: Date): string {
  const fetchedAt = Date.parse(data.fetchedAt);
  return Number.isFinite(fetchedAt) && fetchedAt <= fallback.getTime() + 300_000 ? data.fetchedAt : fallback.toISOString();
}

function emptySnapshot(localDate: string, observedAt: string): ComfortTokenSnapshot {
  return {
    localDate,
    observedAt,
    metricVersion: COMFORT_TOKEN_METRIC_VERSION,
    coverage: "unavailable",
    ...ZERO_TOKEN_COUNTS,
    models: [],
    deviceIds: [],
    missingDeviceIds: [],
    incompleteDeviceIds: [],
  };
}

/**
 * Build one person's aggregate from exact Tokei calendar-day ledger keys.
 * This deliberately uses local midnight boundaries and never the quota 04:00 day.
 */
export function buildTokenComfortSnapshot(
  data: TokeiUsage,
  personId: string,
  localDate: string,
  fallbackObservedAt = new Date(),
): ComfortTokenSnapshot | null {
  if (!validLocalDate(localDate) || !Number.isFinite(fallbackObservedAt.getTime()) || !personId) return null;
  const observedAt = normalizedObservedAt(data, fallbackObservedAt);
  const group = data.groups.find(item => item.id === personId);
  if (!group || group.deviceIds.length === 0) return emptySnapshot(localDate, observedAt);

  const allExpectedIds = [...new Set(group.deviceIds)];
  const expectedIds = allExpectedIds.slice(0, MAX_SNAPSHOT_DEVICES);
  const deviceListTruncated = allExpectedIds.length > expectedIds.length;
  const wanted = new Set(expectedIds);
  const devices = latestDevices(data.devices, wanted);
  const missingDeviceIds = expectedIds.filter(id => !devices.has(id));
  const incompleteDeviceIds: string[] = [];
  const metrics: TokenCounts = { ...ZERO_TOKEN_COUNTS };
  const modelMetrics = new Map<string, ComfortTokenModelUsage>();
  const endTimestamp = dayEndTimestamp(localDate);
  const sourceObservedAt = Date.parse(observedAt);
  let dailyRecordCount = 0;
  let modelBreakdownIncomplete = false;

  for (const id of expectedIds) {
    const device = devices.get(id);
    if (!device) continue;
    const updatedAt = Date.parse(device.updatedAt ?? "");
    if (device.stale || device.collectionPartial || !Number.isFinite(updatedAt)
      || updatedAt < endTimestamp || updatedAt > sourceObservedAt + 300_000 || data.status === "unavailable") incompleteDeviceIds.push(id);
    const day: DailyModelUsage | undefined = device.daily[localDate];
    if (!day) {
      if (!incompleteDeviceIds.includes(id)) incompleteDeviceIds.push(id);
      continue;
    }
    dailyRecordCount += 1;
    addUsage(metrics, day);
    for (const model of day.models) {
      if (!model.id || !model.name) continue;
      if (!modelMetrics.has(model.id) && modelMetrics.size >= MAX_SNAPSHOT_MODELS) {
        modelBreakdownIncomplete = true;
        if (!incompleteDeviceIds.includes(id)) incompleteDeviceIds.push(id);
        continue;
      }
      const aggregate = modelMetrics.get(model.id) ?? {
        id: model.id,
        name: model.name,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
      };
      addUsage(aggregate, model);
      modelMetrics.set(model.id, aggregate);
    }
  }

  const deviceIds = expectedIds.filter(id => devices.has(id));
  const coverage = deviceIds.length === 0 || dailyRecordCount === 0
    ? "unavailable"
    : missingDeviceIds.length === 0 && incompleteDeviceIds.length === 0 && !deviceListTruncated && !modelBreakdownIncomplete
      ? "complete"
      : "partial";
  return {
    localDate,
    observedAt,
    metricVersion: COMFORT_TOKEN_METRIC_VERSION,
    coverage,
    inputTokens: metrics.inputTokens,
    cachedInputTokens: metrics.cachedInputTokens,
    outputTokens: metrics.outputTokens,
    reasoningTokens: metrics.reasoningTokens,
    totalTokens: metrics.inputTokens + metrics.cachedInputTokens + metrics.outputTokens,
    models: [...modelMetrics.values()].sort((left, right) => right.totalTokens - left.totalTokens || left.name.localeCompare(right.name)),
    deviceIds,
    missingDeviceIds,
    incompleteDeviceIds,
  };
}

const COMFORT_SCORE: Record<ComfortCode, number> = { idle: 0, comfortable: 1, overloaded: 2 };

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function samePerson(record: ComfortFeedbackRecord, personId: string | null): boolean {
  return (record.personId ?? null) === personId;
}

function localDateAt(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function validSnapshotRecord(record: ComfortFeedbackRecord, now: Date): boolean {
  const snapshot = record.tokenSnapshot;
  if (!snapshot || !validLocalDate(record.localDate) || record.localDate > localDateAt(now)
    || snapshot.localDate !== record.localDate
    || !Number.isFinite(Date.parse(record.observedAt)) || Date.parse(record.observedAt) > now.getTime() + 300_000
    || !Number.isFinite(Date.parse(snapshot.observedAt)) || Date.parse(snapshot.observedAt) > now.getTime() + 300_000
    || (snapshot.coverage !== "complete" && snapshot.coverage !== "partial" && snapshot.coverage !== "unavailable")) return false;
  const counts = [snapshot.inputTokens, snapshot.cachedInputTokens, snapshot.outputTokens, snapshot.reasoningTokens, snapshot.totalTokens];
  return counts.every(value => Number.isSafeInteger(value) && value >= 0)
    && snapshot.totalTokens === snapshot.inputTokens + snapshot.cachedInputTokens + snapshot.outputTokens;
}

function deduplicatePersonRecords(records: readonly ComfortFeedbackRecord[], personId: string | null, now: Date): ComfortFeedbackRecord[] {
  const result = new Map<string, ComfortFeedbackRecord>();
  for (const record of records) {
    if (!samePerson(record, personId) || !validSnapshotRecord(record, now)) continue;
    const previous = result.get(record.localDate);
    if (!previous || Date.parse(record.observedAt) >= Date.parse(previous.observedAt)) result.set(record.localDate, record);
  }
  return [...result.values()].sort((left, right) => left.localDate.localeCompare(right.localDate));
}

function empiricalTrend(complete: readonly TokenComfortObservation[], distinctTokenCount: number): TokenComfortTrendPoint[] {
  const groups = new Map<number, TokenComfortObservation[]>();
  for (const observation of complete) {
    const bucket = groups.get(observation.tokenMillions) ?? [];
    bucket.push(observation);
    groups.set(observation.tokenMillions, bucket);
  }
  const distinct = [...groups.entries()].sort((left, right) => left[0] - right[0]);
  const binCount = Math.min(5, distinctTokenCount, Math.max(3, Math.floor(Math.sqrt(complete.length))));
  const points: TokenComfortTrendPoint[] = [];
  for (let index = 0; index < binCount; index += 1) {
    const start = Math.floor(index * distinct.length / binCount);
    const end = Math.floor((index + 1) * distinct.length / binCount);
    const observations = distinct.slice(start, end).flatMap(([, values]) => values);
    if (observations.length === 0) continue;
    const tokens = observations.map(item => item.tokenMillions);
    points.push({
      tokenMillions: round(tokens.reduce((sum, value) => sum + value, 0) / tokens.length),
      comfortScore: round(observations.reduce((sum, item) => sum + COMFORT_SCORE[item.comfort], 0) / observations.length),
      minTokenMillions: Math.min(...tokens),
      maxTokenMillions: Math.max(...tokens),
      sampleCount: observations.length,
    });
  }
  return points;
}

/** Descriptive subjective scatter/trend only; it never feeds quota budgeting. */
export function buildTokenComfortModel(
  records: readonly ComfortFeedbackRecord[],
  personId: string | null,
  now = new Date(),
): TokenComfortModel {
  const observations: TokenComfortObservation[] = Number.isFinite(now.getTime())
    ? deduplicatePersonRecords(records, personId, now)
      .filter(record => record.tokenSnapshot?.coverage !== "unavailable")
      .map(record => ({
        localDate: record.localDate,
        tokenMillions: round((record.tokenSnapshot?.totalTokens ?? 0) / 1_000_000),
        comfort: record.comfort,
        coverage: record.tokenSnapshot?.coverage ?? "unavailable",
        eligibleForFit: record.tokenSnapshot?.coverage === "complete",
      }))
    : [];
  const complete = observations.filter(item => item.eligibleForFit);
  const distinctValues = new Set(complete.map(item => item.tokenMillions));
  const completeTokens = complete.map(item => item.tokenMillions * 1_000_000);
  const tokenRange = completeTokens.length > 0 ? Math.max(...completeTokens) - Math.min(...completeTokens) : 0;
  const canFit = complete.length >= TOKEN_COMFORT_MIN_COMPLETE_DAYS
    && distinctValues.size >= TOKEN_COMFORT_MIN_DISTINCT_VALUES
    && tokenRange >= TOKEN_COMFORT_MIN_RANGE_TOKENS;
  return {
    metricVersion: TOKEN_COMFORT_MODEL_VERSION,
    personId,
    mode: canFit ? "empirical-fit" : "scatter-only",
    sampleCount: observations.length,
    completeSampleCount: complete.length,
    distinctTokenCount: distinctValues.size,
    observations,
    trend: canFit ? { method: "binned-ordinal-mean-v1", points: empiricalTrend(complete, distinctValues.size) } : null,
  };
}

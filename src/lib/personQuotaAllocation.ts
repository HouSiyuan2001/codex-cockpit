import type { ComfortQuotaAllocation, ComfortUsageCoverage } from "../types";
import { MAX_DAILY_OBSERVED_PERCENT } from "../types";
import type { TokeiDevice, TokeiUsage } from "./tokeiUsage";

export const PERSON_QUOTA_ALLOCATION_VERSION = "cost-share-v1" as const;

const MAX_ALLOCATION_DEVICES = 128;
const MAX_DEVICE_ID_LENGTH = 128;
const FUTURE_TOLERANCE_MS = 300_000;

export interface SharedDailyQuotaReference {
  observedUsedPercent: number | null;
  usageCoverage: ComfortUsageCoverage;
  usageObservedAt: string | null;
}

function validLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(year, month - 1, day, 12);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

function localDateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function dayEndTimestamp(localDate: string): number {
  const [year, month, day] = localDate.split("-").map(Number);
  return new Date(year, month - 1, day + 1, 0, 0, 0, 0).getTime();
}

function safeDeviceId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_DEVICE_ID_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validCost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000;
}

function validPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_DAILY_OBSERVED_PERCENT;
}

function validCoverage(value: unknown): value is ComfortUsageCoverage {
  return value === "complete" || value === "partial" || value === "unavailable";
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function observedAtFor(data: TokeiUsage, now: Date): string {
  const fetchedAt = Date.parse(data.fetchedAt);
  return Number.isFinite(fetchedAt) && fetchedAt <= now.getTime() + FUTURE_TOLERANCE_MS
    ? data.fetchedAt
    : now.toISOString();
}

function unavailableAllocation(
  localDate: string,
  observedAt: string,
  totalUsedPercent: number | null,
  deviceIds: string[] = [],
  missingDeviceIds: string[] = [],
): ComfortQuotaAllocation {
  return {
    metricVersion: PERSON_QUOTA_ALLOCATION_VERSION,
    localDate,
    observedAt,
    totalUsedPercent,
    personCostUsd: null,
    totalCostUsd: null,
    costShare: null,
    allocatedUsedPercent: null,
    coverage: "unavailable",
    deviceIds,
    missingDeviceIds,
  };
}

/** Select the newest usable copy of each device without trusting future timestamps. */
function uniqueDevices(data: TokeiUsage, expected: ReadonlySet<string>, now: Date): Map<string, TokeiDevice> {
  const result = new Map<string, TokeiDevice>();
  for (const device of data.devices) {
    if (!expected.has(device.id) || !safeDeviceId(device.id)) continue;
    const updatedAt = Date.parse(device.updatedAt ?? "");
    if (!Number.isFinite(updatedAt) || updatedAt > now.getTime() + FUTURE_TOLERANCE_MS) continue;
    const previous = result.get(device.id);
    const previousUpdatedAt = Date.parse(previous?.updatedAt ?? "") || Number.NEGATIVE_INFINITY;
    if (!previous || updatedAt >= previousUpdatedAt) result.set(device.id, device);
  }
  return result;
}

/**
 * Estimate one person's share of a shared quota percentage from exact calendar-day
 * costs. Cost and quota use different day boundaries, so partial coverage remains
 * explicit and the result is descriptive rather than an exact provider allocation.
 */
export function buildPersonQuotaAllocation(
  data: TokeiUsage,
  personId: string,
  localDate: string,
  total: SharedDailyQuotaReference,
  now = new Date(),
): ComfortQuotaAllocation | null {
  const person = data.groups.find(group => group.id === personId);
  if (!person) return null;
  if (!validLocalDate(localDate) || !Number.isFinite(now.getTime())) return null;

  const observedAt = observedAtFor(data, now);
  const totalUsedPercent = validPercent(total.observedUsedPercent) ? total.observedUsedPercent : null;
  const totalObservedAt = total.usageObservedAt === null ? null : Date.parse(total.usageObservedAt);
  const invalidQuotaReference = totalUsedPercent === null || !validCoverage(total.usageCoverage) || total.usageCoverage === "unavailable"
    || (totalObservedAt !== null && (!Number.isFinite(totalObservedAt) || totalObservedAt > now.getTime() + FUTURE_TOLERANCE_MS));
  if (localDate > localDateKey(now) || invalidQuotaReference) return unavailableAllocation(localDate, observedAt, totalUsedPercent);

  // All configured ids plus readable unassigned devices form the shared-cost denominator.
  const configuredIds = data.groups.flatMap(group => group.deviceIds).filter(safeDeviceId);
  const readableIds = data.devices.map(device => device.id).filter(safeDeviceId);
  const allExpectedIds = [...new Set([...configuredIds, ...readableIds])];
  const expectedIds = allExpectedIds.slice(0, MAX_ALLOCATION_DEVICES);
  const expected = new Set(expectedIds);
  const devices = uniqueDevices(data, expected, now);
  const personExpectedIds = [...new Set(person.deviceIds.filter(safeDeviceId))];
  const personExpected = new Set(personExpectedIds);
  const deviceIds: string[] = [];
  const missingDeviceIds: string[] = [];
  const costByDevice = new Map<string, number>();
  const dayEnd = dayEndTimestamp(localDate);
  const fetchedAt = Date.parse(data.fetchedAt);
  let sourceIncomplete = allExpectedIds.length > expectedIds.length || data.status !== "ready"
    || !Number.isFinite(fetchedAt) || fetchedAt > now.getTime() + FUTURE_TOLERANCE_MS;

  for (const id of expectedIds) {
    const device = devices.get(id);
    const day = device?.daily[localDate];
    if (!device || !day || !validCost(day.estimatedCostUsd)) {
      missingDeviceIds.push(id);
      continue;
    }
    const updatedAt = Date.parse(device.updatedAt ?? "");
    if (device.stale || device.collectionPartial || updatedAt < dayEnd) sourceIncomplete = true;
    costByDevice.set(id, day.estimatedCostUsd);
    deviceIds.push(id);
  }

  const knownTotalCost = [...costByDevice.values()].reduce((sum, cost) => sum + cost, 0);
  if (!(knownTotalCost > 0)) {
    return unavailableAllocation(localDate, observedAt, totalUsedPercent, deviceIds, missingDeviceIds);
  }

  const knownPersonCosts = personExpectedIds
    .map(id => costByDevice.get(id))
    .filter((cost): cost is number => cost !== undefined);
  const knownPersonCost = knownPersonCosts.reduce((sum, cost) => sum + cost, 0);
  const personHasUnknownCost = personExpectedIds.length === 0
    || personExpectedIds.some(id => !costByDevice.has(id));
  // A positive observed numerator remains a usable estimate under partial coverage.
  // A zero with missing person devices is unknown, not evidence of zero usage.
  const personCostUsd = knownPersonCost > 0 || !personHasUnknownCost ? knownPersonCost : null;
  const totalCostUsd = knownTotalCost;
  const costShare = personCostUsd === null ? null : round(Math.min(1, Math.max(0, personCostUsd / totalCostUsd)), 8);
  const allocatedUsedPercent = costShare === null ? null : round(Math.min(totalUsedPercent, totalUsedPercent * costShare), 4);
  const coverage: ComfortUsageCoverage = personCostUsd === null
    ? "partial"
    : !sourceIncomplete && missingDeviceIds.length === 0 && total.usageCoverage === "complete"
      ? "complete"
      : "partial";

  return {
    metricVersion: PERSON_QUOTA_ALLOCATION_VERSION,
    localDate,
    observedAt,
    totalUsedPercent,
    personCostUsd,
    totalCostUsd,
    costShare,
    allocatedUsedPercent,
    coverage,
    deviceIds,
    missingDeviceIds,
  };
}

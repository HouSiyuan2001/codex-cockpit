import type { CodexDailyUsage, ProviderSnapshot, QuotaHistoryPoint } from "../types";
import { trackedQuotaWindows } from "./quotaPace";
import { usageDateKey } from "./usageDay";

const BEIJING_OFFSET_HOURS = 8;
const DAY_MS = 24 * 60 * 60_000;
const WEEKLY_WINDOW_MS = 7 * DAY_MS;
const COMPLETE_DAY_GRACE_MS = 15 * 60_000;

type OfficialQuotaPoint = Pick<QuotaHistoryPoint, "provider" | "capturedAt" | "metric" | "metricKind" | "status" | "resetsAt">;

function usageDayStartMs(localDate: string): number {
  const [year, month, day] = localDate.split("-").map(Number);
  return Date.UTC(year, month - 1, day, 4 - BEIJING_OFFSET_HOURS);
}

function parseTimestamp(value: string | null): number {
  if (!value) return Number.NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function cycleKey(resetsAt: string | null): number {
  const timestamp = parseTimestamp(resetsAt);
  return Number.isFinite(timestamp) ? Math.round(timestamp / 60_000) : Number.NaN;
}

function cycleStartMs(point: OfficialQuotaPoint): number {
  const resetMs = parseTimestamp(point.resetsAt);
  return resetMs - WEEKLY_WINDOW_MS;
}

function isUsablePoint(point: OfficialQuotaPoint): boolean {
  return point.provider === "codex"
    && point.status === "ok"
    && point.metricKind === "percent"
    && point.metric !== null
    && Number.isFinite(point.metric)
    && Number.isFinite(parseTimestamp(point.capturedAt))
    && Number.isFinite(cycleKey(point.resetsAt));
}

function officialPointFromSnapshot(snapshot: ProviderSnapshot, capturedAt: string): OfficialQuotaPoint | null {
  if (snapshot.provider !== "codex" || snapshot.status !== "ok") return null;
  const weeklyWindow = trackedQuotaWindows(snapshot).find((item) => item.period === "weekly")?.window;
  const rateLimit = snapshot.rateLimitSnapshot;
  const metric = weeklyWindow
    ? weeklyWindow.remainingPercent
    : rateLimit && rateLimit.windowDurationMins === 10_080
      ? 100 - rateLimit.usedPercent
      : null;
  const resetsAt = weeklyWindow?.resetsAt ?? rateLimit?.resetsAt ?? null;
  if (metric === null || !Number.isFinite(metric) || !resetsAt || !Number.isFinite(parseTimestamp(resetsAt))) return null;
  return {
    provider: "codex",
    capturedAt,
    metric: Math.min(100, Math.max(0, metric)),
    metricKind: "percent",
    status: "ok",
    resetsAt,
  };
}

function deduplicatePoints(points: readonly OfficialQuotaPoint[]): OfficialQuotaPoint[] {
  const result = new Map<string, OfficialQuotaPoint>();
  for (const point of points) {
    const capturedAt = parseTimestamp(point.capturedAt);
    const key = `${capturedAt}:${cycleKey(point.resetsAt)}:${point.metric}`;
    result.set(key, point);
  }
  return [...result.values()].sort((left, right) => parseTimestamp(left.capturedAt) - parseTimestamp(right.capturedAt));
}

function roundedPercent(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10;
}

/**
 * Build one daily lower-bound from official remaining-percent snapshots.
 * A drop in remaining quota is usage. A reset starts from 100% again and is
 * added separately. The result never treats session token_count events as a
 * substitute for the official quota snapshot.
 */
export function buildOfficialDailyUsageForDate(
  localDate: string,
  points: readonly OfficialQuotaPoint[],
  now = new Date(),
): CodexDailyUsage | null {
  const dayStart = usageDayStartMs(localDate);
  const dayEnd = dayStart + DAY_MS;
  const observationEnd = Math.min(dayEnd, now.getTime());
  if (observationEnd < dayStart) return null;

  const usable = deduplicatePoints(points).filter((point) => {
    const capturedAt = parseTimestamp(point.capturedAt);
    return capturedAt <= observationEnd;
  });
  const inDay = usable.filter((point) => {
    const capturedAt = parseTimestamp(point.capturedAt);
    return capturedAt >= dayStart && capturedAt < dayEnd && capturedAt <= observationEnd;
  });
  if (inDay.length === 0) return null;

  const anchor = [...usable].reverse().find((point) => parseTimestamp(point.capturedAt) < dayStart);
  const anchorIsClose = anchor !== undefined && dayStart - parseTimestamp(anchor.capturedAt) <= COMPLETE_DAY_GRACE_MS;
  const sequence = anchorIsClose && anchor ? [anchor, ...inDay] : inDay;
  let observedUsedPercent = 0;
  let missingBaseline = !anchorIsClose && parseTimestamp(inDay[0].capturedAt) > dayStart + COMPLETE_DAY_GRACE_MS;
  let activeCycle = cycleKey(sequence[0].resetsAt);
  let segmentBaseline = sequence[0].metric ?? 0;
  let segmentMinimum = segmentBaseline;
  const firstStartedAt = cycleStartMs(sequence[0]);
  if (firstStartedAt >= dayStart && firstStartedAt <= parseTimestamp(sequence[0].capturedAt)) {
    segmentBaseline = 100;
    if (!inDay.some((point) => parseTimestamp(point.capturedAt) < firstStartedAt)) missingBaseline = true;
  }

  for (let index = 1; index < sequence.length; index += 1) {
    const current = sequence[index];
    const currentCycle = cycleKey(current.resetsAt);
    if (currentCycle === activeCycle) {
      segmentMinimum = Math.min(segmentMinimum, current.metric ?? segmentMinimum);
      continue;
    }

    observedUsedPercent += Math.max(0, segmentBaseline - segmentMinimum);
    const startedAt = cycleStartMs(current);
    if (startedAt >= dayStart && startedAt <= parseTimestamp(current.capturedAt)) {
      segmentBaseline = 100;
      const hasPreResetPoint = inDay.some((point) => parseTimestamp(point.capturedAt) < startedAt);
      if (!hasPreResetPoint) missingBaseline = true;
    } else {
      // The first point in a cycle still gives a valid lower bound for later
      // drops, but its usage before that point is unknown.
      segmentBaseline = current.metric ?? 0;
      missingBaseline = true;
    }
    segmentMinimum = current.metric ?? segmentBaseline;
    activeCycle = currentCycle;
  }
  observedUsedPercent += Math.max(0, segmentBaseline - segmentMinimum);

  const firstObservedAt = inDay[0].capturedAt;
  const lastObservedAt = inDay[inDay.length - 1].capturedAt;
  const coverage = !missingBaseline && parseTimestamp(firstObservedAt) <= dayStart + COMPLETE_DAY_GRACE_MS
    ? "complete"
    : "partial";
  return {
    localDate,
    observedUsedPercent: roundedPercent(observedUsedPercent),
    sampleCount: inDay.length,
    firstObservedAt,
    lastObservedAt,
    coverage,
    source: "official-snapshot",
  };
}

export function buildOfficialDailyUsageHistory(
  history: readonly QuotaHistoryPoint[],
  currentSnapshot: ProviderSnapshot | null = null,
  now = new Date(),
): CodexDailyUsage[] {
  const currentPoint = currentSnapshot ? officialPointFromSnapshot(currentSnapshot, now.toISOString()) : null;
  const points = deduplicatePoints([
    ...history.filter(isUsablePoint),
    ...(currentPoint ? [currentPoint] : []),
  ]).filter((point) => parseTimestamp(point.capturedAt) <= now.getTime());
  const dates = [...new Set(points.map((point) => usageDateKey(new Date(point.capturedAt))))].sort().reverse();
  return dates
    .map((localDate) => buildOfficialDailyUsageForDate(localDate, points, now))
    .filter((item): item is CodexDailyUsage => item !== null);
}

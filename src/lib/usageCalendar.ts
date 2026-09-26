import { canonicalModelId, localDateKey, type DailyModelUsage, type ProjectUsageSnapshot, type TokeiDevice, type TokeiUsage, type UsageMetric } from "./tokeiUsage";

export type CalendarScale = "day" | "week" | "month" | "quarter" | "year";
export interface UsageDateRange { start: string; end: string; scale: CalendarScale }
export const dateAtNoon = (key: string) => new Date(`${key}T12:00:00`);
export function shiftDate(date: Date, days: number) { const next = new Date(date); next.setDate(next.getDate() + days); return next; }
/** Only render the complete calendar weeks intersecting the requested month. */
export function calendarMonthCellCount(year: number, month: number) {
  const leading = (new Date(year, month, 1, 12).getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0, 12).getDate();
  return Math.ceil((leading + days) / 7) * 7;
}
export function calendarRange(date: Date, scale: CalendarScale): UsageDateRange {
  let start = new Date(date), end = new Date(date);
  const year = date.getFullYear(), month = date.getMonth();
  if (scale === "week") { start = shiftDate(date, -((date.getDay() + 6) % 7)); end = shiftDate(start, 6); }
  if (scale === "month") { start = new Date(year, month, 1, 12); end = new Date(year, month + 1, 0, 12); }
  if (scale === "quarter") { const first = Math.floor(month / 3) * 3; start = new Date(year, first, 1, 12); end = new Date(year, first + 3, 0, 12); }
  if (scale === "year") { start = new Date(year, 0, 1, 12); end = new Date(year, 11, 31, 12); }
  return { start: localDateKey(start), end: localDateKey(end), scale };
}
export function rangeLabel(range: UsageDateRange) { return range.start === range.end ? range.start : `${range.start} – ${range.end}`; }
export function isoWeekNumber(date: Date) {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  utc.setUTCDate(utc.getUTCDate() + 4 - (utc.getUTCDay() || 7));
  return Math.ceil(((utc.getTime() - Date.UTC(utc.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
}
export function newestDevices(devices: TokeiDevice[]) {
  const unique = new Map<string, TokeiDevice>();
  for (const device of devices) {
    const previous = unique.get(device.id);
    if (!previous || (Date.parse(device.updatedAt ?? "") || 0) > (Date.parse(previous.updatedAt ?? "") || 0)) unique.set(device.id, device);
  }
  return [...unique.values()];
}
const inRange = (date: string, range: UsageDateRange, today: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= range.start && date <= range.end && date <= today;
function filterDaily(daily: Record<string, DailyModelUsage>, range: UsageDateRange, today: string) {
  return Object.fromEntries(Object.entries(daily).filter(([date]) => inRange(date, range, today)));
}
/** A read-only projection for existing aggregators; never distributes range totals into days. */
export function usageInRange(data: TokeiUsage, range: UsageDateRange, now = new Date()): TokeiUsage {
  const today = localDateKey(now);
  const endExclusive = localDateKey(shiftDate(dateAtNoon(range.end < today ? range.end : today), 1));
  return { ...data, devices: data.devices.map((device): TokeiDevice => {
    const exact = Object.values(device.ranges).find(value => value.start === range.start && value.end === endExclusive);
    return { ...device, daily: filterDaily(device.daily, range, today), ranges: exact ? { all: { ...exact, start: null, end: null } } : {} };
  }) };
}
export function tasksInRange(data: ProjectUsageSnapshot, range: UsageDateRange, now = new Date()): ProjectUsageSnapshot {
  const today = localDateKey(now);
  const filter = <T extends { daily: Record<string, DailyModelUsage> }>(rows: T[]) => rows.map(row => ({ ...row, daily: filterDaily(row.daily, range, today) }));
  return { ...data, projects: filter(data.projects), tasks: data.tasks && filter(data.tasks), peerTasks: data.peerTasks?.map(peer => ({ ...peer, tasks: filter(peer.tasks) })) };
}
/** Null means no known value. Zero is reserved for an explicit zero-valued ledger. */
export function calendarValue(devices: TokeiDevice[], range: UsageDateRange, metric: UsageMetric, now = new Date()) {
  let value: number | null = null, partial = false;
  const today = localDateKey(now);
  const expectedDates = new Set<string>();
  for (let date = dateAtNoon(range.start); localDateKey(date) <= range.end && localDateKey(date) <= today; date = shiftDate(date, 1)) {
    expectedDates.add(localDateKey(date));
  }
  // An open day is not a complete observation even when every device has synced.
  if (expectedDates.has(today)) partial = true;
  for (const device of newestDevices(devices)) {
    const seen = new Set<string>();
    for (const [date, day] of Object.entries(device.daily)) {
      if (!inRange(date, range, today)) continue;
      seen.add(date);
      const known = metric === "tokens" ? day.totalTokens : day.estimatedCostUsd;
      if (known !== null) value = (value ?? 0) + known;
      else {
        partial = true;
        for (const model of day.models) if (model.estimatedCostUsd !== null) value = (value ?? 0) + model.estimatedCostUsd;
      }
      if (metric === "cost" && day.models.some(model => model.costIncomplete)) partial = true;
    }
    if (seen.size < expectedDates.size || device.collectionPartial || device.stale) partial = true;
  }
  return { value, partial };
}

/** Known per-model amounts for a date cell; unknown cost remains in the ring track. */
export function calendarModelSegments(devices: TokeiDevice[], range: UsageDateRange, metric: UsageMetric, now = new Date()) {
  const today = localDateKey(now);
  const segments = new Map<string, number>();
  for (const device of newestDevices(devices)) for (const [date, day] of Object.entries(device.daily)) {
    if (!inRange(date, range, today)) continue;
    for (const model of day.models) {
      const value = metric === "cost" ? model.estimatedCostUsd : model.totalTokens;
      if (value === null || value <= 0) continue;
      const id = canonicalModelId(model.id);
      segments.set(id, (segments.get(id) ?? 0) + value);
    }
  }
  return [...segments].sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => ({ id, value }));
}

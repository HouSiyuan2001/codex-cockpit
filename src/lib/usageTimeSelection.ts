import type { UsageDateRange } from "./usageCalendar";

export const USAGE_PERIODS = ["today", "7d", "30d", "all"] as const;
export type UsageTimeSelection = {
  period: typeof USAGE_PERIODS[number];
  dateRange: UsageDateRange | null;
};
export type UsageTimeSelectionBinding = [
  UsageTimeSelection,
  (selection: UsageTimeSelection) => void,
];

const STORAGE_KEY = "cockpit-usage-time-selection";
export const DEFAULT_USAGE_TIME_SELECTION: UsageTimeSelection = { period: "today", dateRange: null };

function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function loadUsageTimeSelection(): UsageTimeSelection {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    const period = USAGE_PERIODS.find(value => value === saved?.period) ?? "today";
    const range = saved?.dateRange;
    const dateRange = isDateKey(range?.start) && isDateKey(range?.end) && range.start <= range.end
      && ["day", "week", "month", "quarter", "year"].includes(range.scale)
      ? { start: range.start, end: range.end, scale: range.scale }
      : null;
    return { period, dateRange };
  } catch {
    return DEFAULT_USAGE_TIME_SELECTION;
  }
}

export function saveUsageTimeSelection(selection: UsageTimeSelection) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // The current selection still works if storage is unavailable.
  }
}

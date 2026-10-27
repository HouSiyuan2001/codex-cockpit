export const USAGE_DAY_START_HOUR = 4;
export const USAGE_TIME_ZONE = "Asia/Shanghai";

export function beijingParts(date: Date): { year: number; month: number; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: USAGE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour") };
}

function shiftBeijingDate(parts: Pick<ReturnType<typeof beijingParts>, "year" | "month" | "day">, offsetDays: number): string {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offsetDays));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

/** Shared calendar day, independent of the operating system timezone. */
export function localDateKey(date: Date): string {
  return shiftBeijingDate(beijingParts(date), 0);
}

/** Calendar arithmetic uses Beijing noon (04:00 UTC) and UTC getters/setters. */
export function calendarDate(year: number, month: number, day = 1): Date {
  return new Date(Date.UTC(year, month, day, 4));
}

export function dateAtBeijingNoon(key: string): Date {
  return new Date(`${key}T12:00:00+08:00`);
}

export function usageDateKey(date: Date): string {
  const parts = beijingParts(date);
  const today = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  return parts.hour < USAGE_DAY_START_HOUR ? shiftBeijingDate(parts, -1) : today;
}

export function endOfUsageDay(now: Date): number {
  const [year, month, day] = usageDateKey(now).split("-").map(Number);
  return Date.UTC(year, month - 1, day + 1, USAGE_DAY_START_HOUR - 8, 0, 0);
}

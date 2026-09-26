export const USAGE_DAY_START_HOUR = 4;
export const USAGE_TIME_ZONE = "Asia/Shanghai";

function beijingParts(date: Date): { year: number; month: number; day: number; hour: number } {
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

export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

/** Test fixtures describe China wall-clock time without changing the host TZ. */
export function chinaTime(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, millisecond = 0): Date {
  return new Date(Date.UTC(year, month, day, hour - 8, minute, second, millisecond));
}

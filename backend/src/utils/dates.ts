import { format, parse } from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";

/**
 * Returns the start of today (00:00:00) in the given timezone, as a UTC Date.
 */
export function startOfTodayInTz(now: Date, tz: string): Date {
  const zonedNow = toZonedTime(now, tz);
  zonedNow.setHours(0, 0, 0, 0);
  return fromZonedTime(zonedNow, tz);
}

/**
 * Returns the start of the current week (Monday 00:00:00) in the given timezone,
 * as a UTC Date.
 */
export function startOfWeekMondayInTz(now: Date, tz: string): Date {
  const zonedNow = toZonedTime(now, tz);
  const day = zonedNow.getDay(); // 0 = Sun, 1 = Mon, ...
  // Treat Sunday as the day AFTER the last Monday (so subtract 6, not 0).
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  zonedNow.setDate(zonedNow.getDate() - daysSinceMonday);
  zonedNow.setHours(0, 0, 0, 0);
  return fromZonedTime(zonedNow, tz);
}

/**
 * Parse a "YYYY-MM-DD HH:MM" string in the given timezone and return a UTC Date.
 * Returns null if the input isn't parseable.
 */
export function parseDateInTz(input: string, tz: string): Date | null {
  const parsed = parse(input.trim(), "yyyy-MM-dd HH:mm", new Date());
  if (Number.isNaN(parsed.getTime())) return null;
  return fromZonedTime(parsed, tz);
}

/**
 * Format a Date for display in the given timezone.
 */
export function formatInTz(date: Date, tz: string, pattern = "yyyy-MM-dd HH:mm"): string {
  return format(toZonedTime(date, tz), pattern);
}

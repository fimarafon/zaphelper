import { format, parse } from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";

export interface ParsedDateRange {
  /** UTC Date representing 00:00:00 on the start day in the given TZ. */
  start: Date;
  /** UTC Date representing 23:59:59.999 on the end day in the given TZ. */
  end: Date;
  /** Human-friendly label for the report header (e.g. "Apr 9" or "Apr 3 → Apr 9"). */
  label: string;
  /** Short date used as the "(MM/DD)" subtitle. */
  shortDate: string;
}

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

/**
 * Returns the start of yesterday in the given timezone, as a UTC Date.
 */
export function startOfYesterdayInTz(now: Date, tz: string): Date {
  const zonedNow = toZonedTime(now, tz);
  zonedNow.setDate(zonedNow.getDate() - 1);
  zonedNow.setHours(0, 0, 0, 0);
  return fromZonedTime(zonedNow, tz);
}

/**
 * Returns the end of yesterday (23:59:59.999) in the given timezone, as a UTC Date.
 */
export function endOfYesterdayInTz(now: Date, tz: string): Date {
  const zonedNow = toZonedTime(now, tz);
  zonedNow.setDate(zonedNow.getDate() - 1);
  zonedNow.setHours(23, 59, 59, 999);
  return fromZonedTime(zonedNow, tz);
}

/**
 * Returns the start of a day N days ago in the given timezone, as a UTC Date.
 * N=0 is today, N=1 is yesterday, N=7 is 7 days ago.
 */
export function startOfNDaysAgoInTz(now: Date, tz: string, n: number): Date {
  const zonedNow = toZonedTime(now, tz);
  zonedNow.setDate(zonedNow.getDate() - n);
  zonedNow.setHours(0, 0, 0, 0);
  return fromZonedTime(zonedNow, tz);
}

/**
 * Returns the start of the current month (day 1, 00:00:00) in the given
 * timezone, as a UTC Date.
 */
export function startOfMonthInTz(now: Date, tz: string): Date {
  const zonedNow = toZonedTime(now, tz);
  zonedNow.setDate(1);
  zonedNow.setHours(0, 0, 0, 0);
  return fromZonedTime(zonedNow, tz);
}

/**
 * Given an arbitrary date object (already in the correct TZ logic), produce a
 * UTC Date that represents 23:59:59.999 of the same calendar day in `tz`.
 */
export function endOfDayInTz(date: Date, tz: string): Date {
  const zoned = toZonedTime(date, tz);
  zoned.setHours(23, 59, 59, 999);
  return fromZonedTime(zoned, tz);
}

/**
 * Parse a single date token in any of these formats:
 *   - "MM/DD"       → current year (e.g. "04/09" → 2026-04-09)
 *   - "M/D"         → "4/9" → 2026-04-09
 *   - "MM/DD/YYYY"  → "04/09/2026"
 *   - "YYYY-MM-DD"  → "2026-04-09" (ISO)
 *   - "MM-DD"       → dash variant of "MM/DD"
 *
 * Returns the start-of-day UTC Date in the given TZ, or null if unparseable.
 * Interprets as MM/DD (US format) — see /status command help.
 */
export function parseDateToken(token: string, tz: string, now: Date): Date | null {
  const trimmed = token.trim();
  if (!trimmed) return null;

  // ISO: 2026-04-09 or 2026/04/09
  const isoMatch = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return buildStartOfDay(parseInt(y!, 10), parseInt(m!, 10), parseInt(d!, 10), tz);
  }

  // MM/DD/YYYY or MM-DD-YYYY
  const fullMatch = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (fullMatch) {
    const [, m, d, y] = fullMatch;
    return buildStartOfDay(parseInt(y!, 10), parseInt(m!, 10), parseInt(d!, 10), tz);
  }

  // MM/DD or MM-DD — assume current year (in the given TZ)
  const shortMatch = trimmed.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (shortMatch) {
    const [, m, d] = shortMatch;
    const zonedNow = toZonedTime(now, tz);
    return buildStartOfDay(zonedNow.getFullYear(), parseInt(m!, 10), parseInt(d!, 10), tz);
  }

  return null;
}

function buildStartOfDay(year: number, month: number, day: number, tz: string): Date | null {
  // Validate ranges before building the Date — avoids silent rollover (e.g. Feb 30).
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Use parse() with a fixed reference so date-fns doesn't auto-correct invalid days.
  const zoned = parse(
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} 00:00`,
    "yyyy-MM-dd HH:mm",
    new Date(),
  );
  if (Number.isNaN(zoned.getTime())) return null;
  // Reject rollover: if date-fns thinks Feb 30 -> Mar 2, the month will differ.
  if (zoned.getMonth() + 1 !== month || zoned.getDate() !== day) return null;
  return fromZonedTime(zoned, tz);
}

/**
 * Parses a /status argument into a date range. Accepts:
 *   - Single date:   "04/09"  → just April 9
 *   - Range:         "04/03to04/09"  or  "04/03 to 04/09"  or  "04/03-04/09"
 *   - ISO:           "2026-04-09"
 *   - Mix of formats in a range
 *
 * Returns a ParsedDateRange, or null if nothing parses.
 */
export function parseStatusRange(
  input: string,
  tz: string,
  now: Date,
): ParsedDateRange | null {
  const cleaned = input.trim();
  if (!cleaned) return null;

  // Try range first — "A to B" / "A-B" / "A..B"
  const rangeMatch = cleaned.match(
    /^(.+?)\s*(?:to|→|-{1,2}|\.{2,3})\s*(.+)$/i,
  );
  if (rangeMatch) {
    const leftToken = rangeMatch[1]!.trim();
    const rightToken = rangeMatch[2]!.trim();

    const left = parseDateToken(leftToken, tz, now);
    const right = parseDateToken(rightToken, tz, now);

    if (left && right) {
      const end = endOfDayInTz(right, tz);
      return {
        start: left,
        end,
        label: `${formatInTz(left, tz, "MMM d")} → ${formatInTz(right, tz, "MMM d")}`,
        shortDate: formatInTz(right, tz, "MM/dd"),
      };
    }
    // fall through — range didn't parse, try as single date
  }

  // Single date
  const single = parseDateToken(cleaned, tz, now);
  if (single) {
    const end = endOfDayInTz(single, tz);
    return {
      start: single,
      end,
      label: formatInTz(single, tz, "MMM d"),
      shortDate: formatInTz(single, tz, "MM/dd"),
    };
  }

  return null;
}

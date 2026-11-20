/**
 * Calendar dates as people in India see them (DEC-169). Times are stored in UTC (R12), but
 * "today" for a partner or a handler is the India (IST, UTC+5:30) calendar day.
 * Date-only values are plain "YYYY-MM-DD" text, which also compares correctly as text.
 */

const IST_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's date in India, e.g. "2026-11-21". */
export function todayInIst(now: Date = new Date()): string {
  return IST_DAY.format(now);
}

/** "2026-11-21" → the Date Prisma stores in a `@db.Date` column (midnight UTC). */
export function dateFromIso(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** A `@db.Date` value back to "2026-11-21" (null stays null). */
export function isoFromDate(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

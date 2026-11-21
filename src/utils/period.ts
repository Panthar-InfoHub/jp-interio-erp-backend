import { todayInIst } from "./istDate.js";

/**
 * Time periods for dashboards and leaderboards (DEC-202): today, this month or all time,
 * as India sees them (DEC-209). Default: this month.
 */
export const PERIODS = ["today", "month", "all"] as const;
export type Period = (typeof PERIODS)[number];
export const DEFAULT_PERIOD: Period = "month";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight in India at the start of "YYYY-MM-DD", as a UTC moment. */
export function istMidnight(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000+05:30`);
}

export interface PeriodRange {
  period: Period;
  /** First moment counted (inclusive). Null = all time (no lower limit). */
  from: Date | null;
  /** Last moment counted: "now" when the numbers were made. */
  to: Date;
}

/**
 * The moments a period covers, e.g. "month" on 21 Nov 2026 = 1 Nov 2026 00:00 IST → now.
 * Queries use `created_at >= from` (when `from` is set) and `created_at <= to`.
 */
export function periodRange(period: Period, now: Date = new Date()): PeriodRange {
  const today = todayInIst(now);
  switch (period) {
    case "today":
      return { period, from: istMidnight(today), to: now };
    case "month":
      return { period, from: istMidnight(`${today.slice(0, 7)}-01`), to: now };
    case "all":
      return { period, from: null, to: now };
  }
}

/**
 * Dormant line (DEC-201): a partner whose last successful scan is before this moment (or
 * who never scanned) is dormant. With `days` = 30 on 21 Nov 2026 it is 22 Oct 2026 00:00
 * IST, so the last 30 India days including today count as "active".
 */
export function dormantCutoff(days: number, now: Date = new Date()): Date {
  // India has no daylight saving, so whole days can be subtracted safely.
  return new Date(istMidnight(todayInIst(now)).getTime() - (days - 1) * DAY_MS);
}

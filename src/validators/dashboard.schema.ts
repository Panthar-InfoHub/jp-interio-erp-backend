import { z } from "zod";
import { DEFAULT_PERIOD, PERIODS } from "../utils/period.js";

/** `?period=today|month|all` on dashboards and leaderboards (DEC-202). Default: month. */
export const periodQuery = z
  .enum(PERIODS, { message: `period must be one of: ${PERIODS.join(", ")}` })
  .default(DEFAULT_PERIOD);

/** What the top-ASM leaderboard is ranked by (DEC-217). Default: points. */
export const ASM_RANKINGS = ["points", "scans", "newPartners"] as const;
export type AsmRanking = (typeof ASM_RANKINGS)[number];

/**
 * GET /api/dashboard?period=&rankAsmsBy= (Module 16; DEC-220, DEC-217). `rankAsmsBy` only
 * matters where a top-ASM leaderboard is shown (Admin, Zonal Head).
 */
export const dashboardSchemas = {
  query: z.object({
    period: periodQuery,
    rankAsmsBy: z
      .enum(ASM_RANKINGS, { message: `rankAsmsBy must be one of: ${ASM_RANKINGS.join(", ")}` })
      .default("points"),
  }),
};

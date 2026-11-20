import { z } from "zod";
import { ADJUST_REASON_MAX, ADJUST_REASON_MIN } from "../services/ledger.service.js";
import { idParams } from "./common.js";

/**
 * POST /api/partners/:id/points-adjustment (Module 8 T6, DEC-135).
 * No upper limit on points (DEC-131); a debit never takes available below zero (DEC-128,
 * checked by the ledger service). No category for now: the reason is the explanation.
 */
export const pointsAdjustmentSchemas = {
  params: idParams,
  body: z.object({
    direction: z.enum(["credit", "debit"], {
      message: 'direction must be "credit" (add points) or "debit" (take points away)',
    }),
    points: z
      .number({ message: "points must be a number" })
      .int("points must be a whole number")
      .positive("points must be above 0")
      .max(Number.MAX_SAFE_INTEGER, "points is too large"),
    reason: z
      .string({ message: "reason is required" })
      .trim()
      .transform((value) => value.replace(/\s+/g, " "))
      .pipe(
        z
          .string()
          .min(ADJUST_REASON_MIN, `Reason must be at least ${ADJUST_REASON_MIN} characters`)
          .max(ADJUST_REASON_MAX, `Reason can be at most ${ADJUST_REASON_MAX} characters`)
      ),
  }),
};

export type PointsAdjustmentInput = z.output<typeof pointsAdjustmentSchemas.body>;

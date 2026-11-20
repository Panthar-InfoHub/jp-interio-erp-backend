import { z } from "zod";

/** GET /api/reports/points-liability (Module 8 T7, DEC-136). No `asOf` = now. */
export const pointsLiabilitySchemas = {
  query: z.object({
    asOf: z.iso
      .datetime({
        offset: true,
        message: "asOf must be a date-time like 2026-11-30T23:59:59+05:30",
      })
      .transform((value) => new Date(value))
      .optional(),
  }),
};

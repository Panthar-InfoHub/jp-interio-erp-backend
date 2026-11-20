import { z } from "zod";
import { listQuery } from "../utils/pagination.js";
import { idParams } from "./common.js";
import { datesInOrder, datesMessage, moment } from "./wallet.schema.js";

/** Longest input kept; matches `scan_attempts.input` (VarChar(500)). */
export const SCAN_INPUT_MAX = 500;

/**
 * POST /api/partner/scans (Module 9 T2, DEC-138, DEC-142).
 * - `code`: what the camera read (the full link) or the code typed by hand. Read strictly
 *   by the service (`parseScanInput`), so a bad code is a scan refusal, not a 400 here.
 * - `deviceId`: optional; the app sends it if it has one.
 * No location (DEC-138). Points never come from the app.
 */
export const scanSchemas = {
  body: z.object({
    code: z
      .string({ message: "code is required" })
      .trim()
      .min(1, "code is required")
      .max(SCAN_INPUT_MAX, `code can be at most ${SCAN_INPUT_MAX} characters`),
    deviceId: z
      .string({ message: "deviceId must be text" })
      .trim()
      .min(1, "deviceId can't be empty")
      .max(100, "deviceId can be at most 100 characters")
      .optional(),
  }),
};

export type ScanInput = z.output<typeof scanSchemas.body>;

/** Scan history filters (Module 9 T4, DEC-145). Newest first by default. */
export const scanHistoryQuery = listQuery({
  sortFields: ["scannedAt"],
  defaultSort: "-scannedAt",
})
  .extend({
    /** At or after this moment. */
    from: moment("from").optional(),
    /** At or before this moment. */
    to: moment("to").optional(),
    productId: z.uuid("Invalid product id").optional(),
  })
  .refine(datesInOrder, datesMessage);
export type ScanHistoryQuery = z.output<typeof scanHistoryQuery>;

/** GET /api/partner/scans — the partner's own scans. */
export const myScansSchemas = { query: scanHistoryQuery };

/** GET /api/partners/:id/scans — one partner's scans, staff view. */
export const partnerScansSchemas = { params: idParams, query: scanHistoryQuery };

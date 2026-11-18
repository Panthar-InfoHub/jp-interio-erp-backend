import { z } from "zod";
import { listQuery } from "../utils/pagination.js";
import { idParams } from "./common.js";

/** GET /api/partners — verified partners only (DEC-105). Newest first by default. */
export const listPartnersSchemas = {
  query: listQuery({ sortFields: ["name", "createdAt"], defaultSort: "-createdAt" }).extend({
    partnerType: z.enum(["carpenter", "dealer", "oem"], "Unknown partner type").optional(),
    zoneId: z.uuid("Invalid zone id").optional(),
    asmId: z.uuid("Invalid ASM id").optional(),
    salesExecutiveId: z.uuid("Invalid Sales Executive id").optional(),
    status: z.enum(["active", "suspended", "deactivated"], "Unknown status").optional(),
    /** Part of the name, phone or business name (any case). */
    search: z.string().trim().min(1).max(100).optional(),
  }),
};

export type ListPartnersQuery = z.output<typeof listPartnersSchemas.query>;

/** GET /api/partners/:id — Partner 360, any state (DEC-105). */
export const partner360Schemas = { params: idParams };

/** Partners. Module 4 Task 9 (DEC-069); Module 5 adds the rest. */

/** POST /api/partners/:id/assign-sales-executive */
export const assignSalesExecutiveSchemas = {
  params: idParams,
  body: z.object({ salesExecutiveId: z.uuid("Invalid Sales Executive id") }),
};

/** POST /api/partners/:id/unassign-sales-executive (no body) */
export const partnerIdSchemas = { params: idParams };

/** POST /api/partners/:id/transfer */
export const transferPartnerSchemas = {
  params: idParams,
  body: z.object({ asmId: z.uuid("Invalid ASM id") }),
};

// ---- Admin: number lookup and "Remove this draft now" (Module 5 T7, DEC-096, DEC-097) ----

/** The number is sent in the body (never the URL), so it is not written to access logs. */
const lookupNumber = (label: string) => z.string(`${label} is required`).trim().min(1).max(100);

/** POST /api/partners/number-lookup. The format of the number is checked in the service. */
export const numberLookupSchemas = {
  body: z.discriminatedUnion(
    "type",
    [
      z.strictObject({ type: z.literal("pan"), number: lookupNumber("PAN") }),
      z.strictObject({ type: z.literal("aadhaar"), number: lookupNumber("Aadhaar") }),
      z.strictObject({ type: z.literal("gst"), number: lookupNumber("GST number") }),
      z.strictObject({
        type: z.literal("bank_account"),
        number: lookupNumber("Bank account number"),
        ifsc: z.string("IFSC is required").trim().min(1).max(20),
      }),
      z.strictObject({ type: z.literal("upi"), number: lookupNumber("UPI ID") }),
    ],
    "type must be pan, aadhaar, gst, bank_account or upi"
  ),
};

export type NumberLookupInput = z.output<typeof numberLookupSchemas.body>;

/** POST /api/partners/:id/remove-draft */
export const removeDraftSchemas = {
  params: idParams,
  body: z.strictObject({
    reason: z
      .string("A reason is required")
      .trim()
      .min(3, "A reason is required (at least 3 characters)")
      .max(500, "Reason must be 500 characters or fewer"),
  }),
};

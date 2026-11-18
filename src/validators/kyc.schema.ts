import { z } from "zod";
import { listQuery } from "../utils/pagination.js";
import { idParams } from "./common.js";

/** KYC queue: approve, reject, undo a rejection (Module 5 T8; DEC-073, DEC-074, DEC-098). */

const reason = (label: string) =>
  z
    .string(`${label} is required`)
    .trim()
    .min(3, `${label} is required (at least 3 characters)`)
    .max(1000, `${label} must be 1000 characters or fewer`);

/** GET /api/kyc/queue — pending by default, oldest submission first. */
export const kycQueueSchemas = {
  query: listQuery({ sortFields: ["submittedAt"], defaultSort: "submittedAt" }).extend({
    /** pending = the queue. rejected / verified to look back (e.g. the Admin finding a rejection to undo). */
    state: z.enum(["pending", "rejected", "verified"], "Unknown state").default("pending"),
    zoneId: z.uuid("Invalid zone id").optional(),
    partnerType: z.enum(["carpenter", "dealer", "oem"], "Unknown partner type").optional(),
    /** Part of the name, phone or business name (any case). */
    search: z.string().trim().min(1).max(100).optional(),
  }),
};

export type KycQueueQuery = z.output<typeof kycQueueSchemas.query>;

/** GET /api/kyc/:id */
export const kycPartnerSchemas = { params: idParams };

/** POST /api/kyc/:id/approve — `asmId` is required for a self sign-up (DEC-074). */
export const approveKycSchemas = {
  params: idParams,
  // No body at all is fine for a field-onboarded partner (they already have an ASM).
  body: z.strictObject({ asmId: z.uuid("Invalid ASM id").optional() }).default({}),
};

/** POST /api/kyc/:id/reject — the reason is shown to the partner (DEC-073, DEC-074). */
export const rejectKycSchemas = {
  params: idParams,
  body: z.strictObject({ reason: reason("Rejection reason") }),
};

/** POST /api/kyc/:id/undo-rejection — Admin only; the partner goes back to the queue (DEC-098). */
export const undoRejectionSchemas = {
  params: idParams,
  body: z.strictObject({ reason: reason("Reason") }),
};

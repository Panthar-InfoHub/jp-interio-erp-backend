import { z } from "zod";
import { idParams } from "./common.js";
import { payoutAccountBody } from "./onboarding.schema.js";

/**
 * Payout accounts after onboarding (Module 5 T10; DEC-076, DEC-078, DEC-101, DEC-102).
 * Number formats are checked in the service (lib/crypto/sensitiveData.ts), so an error
 * never repeats the number back.
 */

const accountParams = z.object({ accountId: z.uuid("Invalid account id") });
const partnerAccountParams = idParams.extend({ accountId: z.uuid("Invalid account id") });

/**
 * Edit: send only what changes. Bank: holderName, accountNumber, ifsc, bankName.
 * UPI: upiId, holderName. Bank ↔ UPI is not an edit (remove and add instead, DEC-102).
 */
const editBody = z
  .strictObject({
    holderName: z.string().trim().max(150).nullable().optional(),
    accountNumber: z.string().min(1).max(100).optional(),
    ifsc: z.string().min(1).max(20).optional(),
    bankName: z.string().trim().max(150).nullable().optional(),
    upiId: z.string().min(1).max(100).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "Send at least one field to change" });

export type PayoutAccountEditInput = z.output<typeof editBody>;

// ---- Partner App: my own accounts ----

/** POST /api/partner/payout-accounts */
export const addMyAccountSchemas = { body: payoutAccountBody };
/** PATCH /api/partner/payout-accounts/:accountId */
export const editMyAccountSchemas = { params: accountParams, body: editBody };
/** POST /api/partner/payout-accounts/:accountId/set-default and /remove */
export const myAccountSchemas = { params: accountParams };

// ---- Staff: a partner's accounts ----

/** GET /api/partners/:id/payout-accounts */
export const partnerAccountsSchemas = { params: idParams };
/** POST /api/partners/:id/payout-accounts */
export const addPartnerAccountSchemas = { params: idParams, body: payoutAccountBody };
/** PATCH /api/partners/:id/payout-accounts/:accountId */
export const editPartnerAccountSchemas = { params: partnerAccountParams, body: editBody };
/** POST /api/partners/:id/payout-accounts/:accountId/set-default and /remove */
export const partnerAccountSchemas = { params: partnerAccountParams };

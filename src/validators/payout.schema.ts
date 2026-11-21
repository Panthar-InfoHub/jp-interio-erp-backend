import { z } from "zod";
import { listQuery } from "../utils/pagination.js";
import { idParams } from "./common.js";
import { datesInOrder, datesMessage, moment } from "./wallet.schema.js";

/** Longest partner note; matches `payouts.partner_note` (VarChar(500), DEC-151). */
export const PAYOUT_NOTE_MAX = 500;

/**
 * POST /api/partner/payouts (Module 10 T2; DEC-149 – DEC-153).
 * - `points`: whole number. The minimum (`payout.min_points`) and the balance are checked
 *   by the service; there is no maximum and no multiple rule (DEC-153).
 * - `payoutAccountId`: one of the partner's saved, not removed accounts (DEC-149).
 * - `note`: optional, up to 500 characters (DEC-151). Empty text counts as no note.
 * The `Idempotency-Key` header is read by `idempotencyKey` below.
 */
export const requestPayoutSchemas = {
  body: z.object({
    points: z
      .number({ message: "points must be a number" })
      .int("points must be a whole number")
      .positive("points must be above 0"),
    payoutAccountId: z.uuid("Invalid payout account id"),
    note: z
      .string({ message: "note must be text" })
      .trim()
      .max(PAYOUT_NOTE_MAX, `note can be at most ${PAYOUT_NOTE_MAX} characters`)
      .optional()
      .transform((value) => (value ? value : null)),
  }),
};

export type RequestPayoutInput = z.output<typeof requestPayoutSchemas.body>;

/** Longest key kept; matches `payouts.idempotency_key` (VarChar(100)). */
export const IDEMPOTENCY_KEY_MAX = 100;

/**
 * The `Idempotency-Key` header: required, 1–100 visible characters (letters, digits and
 * `-_.:` — a UUID fits). One key = one "Cash out" tap; the app makes a new one per request.
 */
export const idempotencyKey = z
  .string({ message: "The Idempotency-Key header is required" })
  .trim()
  .min(1, "The Idempotency-Key header is required")
  .max(
    IDEMPOTENCY_KEY_MAX,
    `The Idempotency-Key header can be at most ${IDEMPOTENCY_KEY_MAX} characters`
  )
  .regex(
    /^[A-Za-z0-9._:-]+$/,
    "The Idempotency-Key header may use only letters, digits and - _ . :"
  );

/** Staff reasons (decline, and later failed): 10 to 500 characters (DEC-154). */
export const PAYOUT_REASON_MIN = 10;
export const PAYOUT_REASON_MAX = 500;

const payoutReason = z
  .string({ message: "reason is required" })
  .trim()
  .transform((value) => value.replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(PAYOUT_REASON_MIN, `Reason must be at least ${PAYOUT_REASON_MIN} characters`)
      .max(PAYOUT_REASON_MAX, `Reason can be at most ${PAYOUT_REASON_MAX} characters`)
  );

/** POST /api/payouts/:id/approve (Module 10 T3, DEC-154). No body (no approval note). */
export const approvePayoutSchemas = { params: idParams };

/** POST /api/payouts/:id/decline (Module 10 T3, DEC-154). The partner sees the reason. */
export const declinePayoutSchemas = {
  params: idParams,
  body: z.object({ reason: payoutReason }),
};

export type DeclinePayoutInput = z.output<typeof declinePayoutSchemas.body>;

// ---- T4: paid, paid-details correction, failed (DEC-155) ----

const paidMethod = z.enum(["cash", "upi", "bank_transfer"], {
  message: "method must be cash, upi or bank_transfer",
});

/** The bank / UPI reference. Not unique (DEC-149). */
const transactionId = z
  .string({ message: "transactionId must be text" })
  .trim()
  .min(1, "transactionId can't be empty")
  .max(100, "transactionId can be at most 100 characters");

/** The `fileUrl` from an upload link with purpose `payout_proof` (checked in the service). */
const proofUrl = z.url("proofUrl must be the fileUrl from the upload link").max(1000);

/** The paid-details rule: a transaction ID for UPI / bank transfer, none for cash (DEC-148). */
export function paidDetailsProblem(
  method: "cash" | "upi" | "bank_transfer",
  txnId: string | null | undefined
): string | null {
  if (method === "cash") return txnId ? "Leave transactionId empty for a cash payment" : null;
  return txnId ? null : "transactionId is required for a UPI or bank transfer payment";
}

/** POST /api/payouts/:id/mark-paid — only from `approved`; paid time is always now. */
export const markPaidSchemas = {
  params: idParams,
  body: z
    .object({
      method: paidMethod,
      transactionId: transactionId.optional(),
      proofUrl: proofUrl.optional(),
    })
    .superRefine((body, ctx) => {
      const problem = paidDetailsProblem(body.method, body.transactionId);
      if (problem) ctx.addIssue({ code: "custom", path: ["transactionId"], message: problem });
    }),
};

export type MarkPaidInput = z.output<typeof markPaidSchemas.body>;

/**
 * PATCH /api/payouts/:id/paid-details — correct the paid details, only while `paid`.
 * Send only what changes; `null` clears the transaction ID (cash) or removes the proof.
 * The method + transaction ID rule is checked on the result by the service. No reason.
 */
export const editPaidDetailsSchemas = {
  params: idParams,
  body: z
    .object({
      method: paidMethod.optional(),
      transactionId: transactionId.nullable().optional(),
      proofUrl: proofUrl.nullable().optional(),
    })
    .refine((body) => Object.values(body).some((value) => value !== undefined), {
      message: "Send at least one of method, transactionId, proofUrl",
    }),
};

export type EditPaidDetailsInput = z.output<typeof editPaidDetailsSchemas.body>;

/** POST /api/payouts/:id/mark-failed — only from `paid`; final; reason 10–500. */
export const markFailedSchemas = {
  params: idParams,
  body: z.object({ reason: payoutReason }),
};

export type MarkFailedInput = z.output<typeof markFailedSchemas.body>;

// ---- T5: lists (DEC-156) ----

const payoutStatus = z.enum(["requested", "approved", "paid", "declined", "failed"], {
  message: "status must be one of: requested, approved, paid, declined, failed",
});

/** Newest first (DEC-156). */
const payoutListBase = listQuery({ sortFields: ["createdAt"], defaultSort: "-createdAt" });

/** GET /api/partner/payouts — the partner's own payouts, optional status filter. */
export const myPayoutsSchemas = {
  query: payoutListBase.extend({ status: payoutStatus.optional() }),
};
export type MyPayoutsQuery = z.output<typeof myPayoutsSchemas.query>;

/** GET /api/partner/payouts/:id and GET /api/payouts/:id */
export const payoutIdSchemas = { params: idParams };

/**
 * GET /api/payouts — staff list within scope (DEC-156). No totals.
 * - `zoneId`: the partner's CURRENT zone (the same rule as scope).
 * - `search`: part of the partner's name, business name or phone, or of the payout number.
 * - `from` / `to`: when it was requested.
 */
export const staffPayoutsSchemas = {
  query: payoutListBase
    .extend({
      status: payoutStatus.optional(),
      zoneId: z.uuid("Invalid zone id").optional(),
      /** One partner's payouts (Partner 360 tab, DEC-258). Still limited to the scope. */
      partnerId: z.uuid("Invalid partner id").optional(),
      search: z.string().trim().min(1).max(100).optional(),
      from: moment("from").optional(),
      to: moment("to").optional(),
      paidMethod: paidMethod.optional(),
    })
    .refine(datesInOrder, datesMessage),
};
export type StaffPayoutsQuery = z.output<typeof staffPayoutsSchemas.query>;

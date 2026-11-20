import { z } from "zod";
import { todayInIst } from "../utils/istDate.js";
import { listQuery } from "../utils/pagination.js";
import { idParams } from "./common.js";
import { datesInOrder, datesMessage, moment } from "./wallet.schema.js";

/**
 * Requests (Module 11; DEC-157 – DEC-169). A verified partner asks for a shipment or a free
 * sample; the handler moves it stage by stage. The `Idempotency-Key` header uses the same
 * rule as payouts (`idempotencyKey` in payout.schema.ts, DEC-169).
 */

/** Longest delivery address and notes; match `partner_requests` (VarChar(500), DEC-169). */
export const REQUEST_TEXT_MAX = 500;
/** Reject / cancel reasons: 10 to 500 characters, free text (DEC-160, DEC-163). */
export const REQUEST_REASON_MIN = 10;
export const REQUEST_REASON_MAX = 500;
/** The biggest whole number the `quantity` column holds. No business maximum (DEC-169). */
const QUANTITY_MAX = 2_147_483_647;

/** A reject / cancel reason: trimmed, inner spaces squeezed, 10 – 500 characters. */
export const requestReason = z
  .string({ message: "reason is required" })
  .trim()
  .transform((value) => value.replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(REQUEST_REASON_MIN, `Reason must be at least ${REQUEST_REASON_MIN} characters`)
      .max(REQUEST_REASON_MAX, `Reason can be at most ${REQUEST_REASON_MAX} characters`)
  );

export const requestCategory = z.enum(["shipment", "sample"], {
  message: "category must be shipment or sample",
});

export const REQUEST_STATUSES = [
  "requested",
  "accepted",
  "rejected",
  "payment_received",
  "processing",
  "dispatched",
  "delivered",
  "completed",
  "cancelled",
  "refund_initiated",
  "refunded",
] as const;

export const requestStatus = z.enum(REQUEST_STATUSES, {
  message: `status must be one of: ${REQUEST_STATUSES.join(", ")}`,
});

const requestItem = z.object({
  productId: z.uuid("Invalid product id"),
  quantity: z
    .number({ message: "quantity must be a number" })
    .int("quantity must be a whole number")
    .positive("quantity must be above 0")
    .max(QUANTITY_MAX, "quantity is too large"),
});

/**
 * POST /api/partner/requests (T3).
 * - `items`: at least one; the same product only once (DEC-165); no maximum.
 * - `deliveryAddress`: one free-text box (the app pre-fills it from the profile), 1 – 500.
 * - `preferredDeliveryDate`: "YYYY-MM-DD", today or later in India time (DEC-169).
 * - `notes`: optional, up to 500. Empty text counts as no notes.
 * Products being switched on is checked by the service (`assertProductUsable`).
 */
export const createRequestSchemas = {
  body: z.object({
    category: requestCategory,
    items: z
      .array(requestItem, { message: "items must be a list" })
      .min(1, "Add at least one product")
      .superRefine((items, ctx) => {
        const seen = new Set<string>();
        items.forEach((item, index) => {
          if (seen.has(item.productId)) {
            ctx.addIssue({
              code: "custom",
              path: [index, "productId"],
              message: "This product is already in the request; change its quantity instead",
            });
          }
          seen.add(item.productId);
        });
      }),
    deliveryAddress: z
      .string({ message: "deliveryAddress is required" })
      .trim()
      .min(1, "deliveryAddress is required")
      .max(REQUEST_TEXT_MAX, `deliveryAddress can be at most ${REQUEST_TEXT_MAX} characters`),
    preferredDeliveryDate: z.iso
      .date("preferredDeliveryDate must be a date like 2026-12-01")
      .refine((value) => value >= todayInIst(), {
        message: "preferredDeliveryDate can't be in the past",
      }),
    notes: z
      .string({ message: "notes must be text" })
      .trim()
      .max(REQUEST_TEXT_MAX, `notes can be at most ${REQUEST_TEXT_MAX} characters`)
      .optional()
      .transform((value) => (value ? value : null)),
  }),
};

export type CreateRequestInput = z.output<typeof createRequestSchemas.body>;

/** Newest first. */
const requestListBase = listQuery({ sortFields: ["createdAt"], defaultSort: "-createdAt" });

/** GET /api/partner/requests — own requests, optional stage and kind filters (T3). */
export const myRequestsSchemas = {
  query: requestListBase.extend({
    status: requestStatus.optional(),
    category: requestCategory.optional(),
  }),
};
export type MyRequestsQuery = z.output<typeof myRequestsSchemas.query>;

/** GET /api/partner/requests/:id and GET /api/requests/:id (staff details, T6). */
export const requestIdSchemas = { params: idParams };

// ---- T6: staff lists (DEC-173) ----

/** open = not finished (default in the worklist); finished; all. Same "open" as DEC-165. */
const requestState = z.enum(["open", "finished", "all"], {
  message: "state must be open, finished or all",
});

/**
 * GET /api/requests/worklist — requests I handle (an ASM also their Sales Executives'),
 * newest first, open ones by default (DEC-173).
 * - `handlerId`: one person inside my team (ASM: myself or one of my Sales Executives).
 * - `search`: part of the request number, or of the partner's name, business name or phone.
 * - `from` / `to`: when the request was made.
 */
export const worklistSchemas = {
  query: requestListBase
    .extend({
      state: requestState.default("open"),
      status: requestStatus.optional(),
      category: requestCategory.optional(),
      handlerId: z.uuid("Invalid handler id").optional(),
      search: z.string().trim().min(1).max(100).optional(),
      from: moment("from").optional(),
      to: moment("to").optional(),
    })
    .refine(datesInOrder, datesMessage),
};
export type WorklistQuery = z.output<typeof worklistSchemas.query>;

/** GET /api/partners/:id/requests — one partner's request history (Partner 360), all by default. */
export const partnerRequestsSchemas = {
  params: idParams,
  query: requestListBase.extend({
    state: requestState.default("all"),
    status: requestStatus.optional(),
    category: requestCategory.optional(),
  }),
};
export type PartnerRequestsQuery = z.output<typeof partnerRequestsSchemas.query>;

/**
 * POST /api/partner/requests/:id/cancel and POST /api/requests/:id/cancel — before
 * Dispatched; reason 10 – 500 (DEC-161). The partner sees the reason (DEC-170).
 */
export const cancelRequestSchemas = {
  params: idParams,
  body: z.object({ reason: requestReason }),
};
export type CancelRequestInput = z.output<typeof cancelRequestSchemas.body>;

// ---- T4: the handler's steps (DEC-159 – DEC-164, DEC-170) ----

/** The biggest amount the `agreed_amount` column holds (Decimal(12,2)). No business maximum. */
const AMOUNT_MAX = 9_999_999_999;

/**
 * POST /api/requests/:id/accept. Shipment: `agreedAmount` in whole rupees, above 0, required
 * (DEC-159, DEC-170). Sample: free, send nothing (DEC-158). Which one applies is checked by
 * the service, which knows the request's kind. The price can't be changed later (DEC-161).
 */
export const acceptRequestSchemas = {
  params: idParams,
  body: z
    .object({
      agreedAmount: z
        .number({ message: "agreedAmount must be a number" })
        .int("agreedAmount must be whole rupees (no paise)")
        .positive("agreedAmount must be above 0")
        .max(AMOUNT_MAX, "agreedAmount is too large")
        .optional(),
    })
    .default({}),
};
export type AcceptRequestInput = z.output<typeof acceptRequestSchemas.body>;

/**
 * POST /api/requests/:id/assign — the ASM gives (or moves) a request to one of their own
 * active Sales Executives, at any open stage; reason 10 – 500 (DEC-171, DEC-172).
 */
export const assignRequestSchemas = {
  params: idParams,
  body: z.object({
    salesExecutiveId: z.uuid("Invalid Sales Executive id"),
    reason: requestReason,
  }),
};
export type AssignRequestInput = z.output<typeof assignRequestSchemas.body>;

/** POST /api/requests/:id/take-back — the ASM becomes the handler again; reason 10 – 500. */
export const takeBackRequestSchemas = cancelRequestSchemas;
export type TakeBackRequestInput = CancelRequestInput;

/** POST /api/requests/:id/reject — only while Requested; reason 10 – 500 (DEC-160). */
export const rejectRequestSchemas = cancelRequestSchemas;
export type RejectRequestInput = CancelRequestInput;

/** Steps with no body: processing, dispatched, delivered, completed, refund-initiated. */
export const plainStepSchemas = { params: idParams };

const paymentMode = z.enum(["cash", "upi", "cheque", "bank"], {
  message: "mode must be cash, upi, cheque or bank",
});

/**
 * Money received (Payment Received) or returned (Refunded) — DEC-160, DEC-163, DEC-166, DEC-170:
 * - `date`: "YYYY-MM-DD", any past date, never in the future (India time). For a refund the
 *   service also checks it is not before the payment date.
 * - `mode`: cash / upi / cheque / bank.
 * - `reference`: required unless cash (optional for cash), up to 100 characters.
 * - `receiptUrl`: optional; the `fileUrl` from an upload link with purpose `request_receipt`.
 *   It can only be given here, not added later (DEC-170).
 * Saved permanently: no corrections for now (DEC-170).
 */
export const moneyStepSchemas = {
  params: idParams,
  body: z
    .object({
      date: z.iso
        .date("date must be a date like 2026-11-21")
        .refine((value) => value <= todayInIst(), { message: "date can't be in the future" }),
      mode: paymentMode,
      reference: z
        .string({ message: "reference must be text" })
        .trim()
        .max(100, "reference can be at most 100 characters")
        .optional()
        .transform((value) => (value ? value : null)),
      receiptUrl: z
        .url("receiptUrl must be the fileUrl from the upload link")
        .max(1000)
        .optional()
        .transform((value) => value ?? null),
    })
    .superRefine((body, ctx) => {
      if (body.mode !== "cash" && !body.reference) {
        ctx.addIssue({
          code: "custom",
          path: ["reference"],
          message: "reference is required for UPI, cheque or bank (not for cash)",
        });
      }
    }),
};
export type MoneyStepInput = z.output<typeof moneyStepSchemas.body>;

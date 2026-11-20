import { getAuthUser } from "../middlewares/auth.js";
import { getScope } from "../middlewares/permission.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import * as payoutService from "../services/payout.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ValidationError } from "../utils/errors.js";
import {
  idempotencyKey,
  type approvePayoutSchemas,
  type declinePayoutSchemas,
  type editPaidDetailsSchemas,
  type markFailedSchemas,
  type markPaidSchemas,
  type myPayoutsSchemas,
  type payoutIdSchemas,
  type staffPayoutsSchemas,
  type requestPayoutSchemas,
} from "../validators/payout.schema.js";

/**
 * POST /api/partner/payouts — the partner asks for a payout (Module 10 T2).
 * 201 for a new payout; 200 for a retry with the same key and details (nothing new).
 */
export const request = asyncHandler<ValidatedRequest<typeof requestPayoutSchemas>>(
  async (req, res) => {
    const key = idempotencyKey.safeParse(req.get("Idempotency-Key"));
    if (!key.success) {
      throw new ValidationError(
        "Invalid request data",
        key.error.issues.map((issue) => ({
          path: "headers.Idempotency-Key",
          message: issue.message,
        }))
      );
    }

    const result = await payoutService.requestPayout(getAuthUser(req), key.data, req.body);
    if (result.alreadyMade) {
      sendSuccess(res, 200, result, "This payout was already requested");
    } else {
      sendSuccess(res, 201, result, `Payout ${result.payout.payoutNo} requested`);
    }
  }
);

/** POST /api/payouts/:id/approve — `payouts.approve` within scope (Module 10 T3). */
export const approve = asyncHandler<ValidatedRequest<typeof approvePayoutSchemas>>(
  async (req, res) => {
    const result = await payoutService.approvePayout(
      getAuthUser(req),
      getScope(req),
      req.params.id
    );
    const message = result.alreadyDone
      ? "This payout was already approved"
      : `Payout ${result.payout.payoutNo} approved`;
    sendSuccess(res, 200, result, message);
  }
);

/** POST /api/payouts/:id/decline — `payouts.approve` within scope; points go back (T3). */
export const decline = asyncHandler<ValidatedRequest<typeof declinePayoutSchemas>>(
  async (req, res) => {
    const result = await payoutService.declinePayout(
      getAuthUser(req),
      getScope(req),
      req.params.id,
      req.body
    );
    const message = result.alreadyDone
      ? "This payout was already declined"
      : `Payout ${result.payout.payoutNo} declined`;
    sendSuccess(res, 200, result, message);
  }
);

/** POST /api/payouts/:id/mark-paid — `payouts.mark_paid` within scope (Module 10 T4). */
export const markPaid = asyncHandler<ValidatedRequest<typeof markPaidSchemas>>(async (req, res) => {
  const result = await payoutService.markPaid(
    getAuthUser(req),
    getScope(req),
    req.params.id,
    req.body
  );
  const message = result.alreadyDone
    ? "This payout was already marked paid"
    : `Payout ${result.payout.payoutNo} marked paid`;
  sendSuccess(res, 200, result, message);
});

/** PATCH /api/payouts/:id/paid-details — correct paid details while paid (Module 10 T4). */
export const editPaidDetails = asyncHandler<ValidatedRequest<typeof editPaidDetailsSchemas>>(
  async (req, res) => {
    const result = await payoutService.editPaidDetails(
      getAuthUser(req),
      getScope(req),
      req.params.id,
      req.body
    );
    const message = result.alreadyDone ? "Nothing changed" : "Paid details updated";
    sendSuccess(res, 200, result, message);
  }
);

/** POST /api/payouts/:id/mark-failed — `payouts.approve` within scope; final (Module 10 T4). */
export const markFailed = asyncHandler<ValidatedRequest<typeof markFailedSchemas>>(
  async (req, res) => {
    const result = await payoutService.markFailed(
      getAuthUser(req),
      getScope(req),
      req.params.id,
      req.body
    );
    const message = result.alreadyDone
      ? "This payout was already marked failed"
      : `Payout ${result.payout.payoutNo} marked failed; points returned`;
    sendSuccess(res, 200, result, message);
  }
);

/** GET /api/partner/payouts — own payouts, newest first, optional status (Module 10 T5). */
export const myPayouts = asyncHandler<ValidatedRequest<typeof myPayoutsSchemas>>(
  async (req, res) => {
    const { items, meta } = await payoutService.listMyPayouts(getAuthUser(req).id, req.query);
    sendSuccess(res, 200, items, undefined, meta);
  }
);

/** GET /api/partner/payouts/:id — one own payout (Module 10 T5). */
export const myPayout = asyncHandler<ValidatedRequest<typeof payoutIdSchemas>>(async (req, res) => {
  const payout = await payoutService.getMyPayout(getAuthUser(req).id, req.params.id);
  sendSuccess(res, 200, payout);
});

/** GET /api/payouts — staff list within scope (Module 10 T5). */
export const list = asyncHandler<ValidatedRequest<typeof staffPayoutsSchemas>>(async (req, res) => {
  const { items, meta } = await payoutService.listPayouts(
    getAuthUser(req),
    getScope(req),
    req.query
  );
  sendSuccess(res, 200, items, undefined, meta);
});

/** GET /api/payouts/:id — one payout with partner context (Module 10 T5). */
export const detail = asyncHandler<ValidatedRequest<typeof payoutIdSchemas>>(async (req, res) => {
  const payout = await payoutService.getPayoutForStaff(
    getAuthUser(req),
    getScope(req),
    req.params.id
  );
  sendSuccess(res, 200, payout);
});

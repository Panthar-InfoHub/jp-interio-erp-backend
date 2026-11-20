import type { Response } from "express";
import { getAuthUser } from "../middlewares/auth.js";
import { getScope } from "../middlewares/permission.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import * as requestService from "../services/request.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ValidationError } from "../utils/errors.js";
import { idempotencyKey } from "../validators/payout.schema.js";
import type {
  assignRequestSchemas,
  takeBackRequestSchemas,
  acceptRequestSchemas,
  cancelRequestSchemas,
  createRequestSchemas,
  moneyStepSchemas,
  myRequestsSchemas,
  partnerRequestsSchemas,
  plainStepSchemas,
  worklistSchemas,
  rejectRequestSchemas,
  requestIdSchemas,
} from "../validators/request.schema.js";

/**
 * POST /api/partner/requests — the partner sends a shipment / sample request (Module 11 T3).
 * Needs an `Idempotency-Key` header (same rule as payouts, DEC-169).
 * 201 for a new request; 200 for a retry with the same key and details (nothing new).
 */
export const createMine = asyncHandler<ValidatedRequest<typeof createRequestSchemas>>(
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

    const result = await requestService.createMyRequest(getAuthUser(req).id, key.data, req.body);
    if (result.alreadyMade) {
      sendSuccess(res, 200, result, "This request was already sent");
    } else {
      sendSuccess(res, 201, result, `Request ${result.request.requestNo} sent`);
    }
  }
);

/** GET /api/partner/requests — own requests, newest first (Module 11 T3). */
export const listMine = asyncHandler<ValidatedRequest<typeof myRequestsSchemas>>(
  async (req, res) => {
    const { items, meta } = await requestService.listMyRequests(getAuthUser(req).id, req.query);
    sendSuccess(res, 200, items, undefined, meta);
  }
);

/** GET /api/partner/requests/:id — one own request with its timeline (Module 11 T3). */
export const getMine = asyncHandler<ValidatedRequest<typeof requestIdSchemas>>(async (req, res) => {
  const request = await requestService.getMyRequest(getAuthUser(req).id, req.params.id);
  sendSuccess(res, 200, request);
});

// ---------------------------------------------------------------------------
// T4: the handler's steps — POST /api/requests/:id/<step>, `requests.handle` (DEC-164)
// ---------------------------------------------------------------------------

type StepResult = Awaited<ReturnType<typeof requestService.runHandlerStep>>;

function sendStep(res: Response, result: StepResult, step: requestService.HandlerStep) {
  const label = requestService.STEP_LABEL[step];
  const message = result.alreadyDone
    ? `This request was already ${label}`
    : `Request ${result.request.requestNo} ${label}`;
  sendSuccess(res, 200, result, message);
}

/** POST /api/requests/:id/accept — shipment: agreed total in whole rupees; sample: nothing. */
export const accept = asyncHandler<ValidatedRequest<typeof acceptRequestSchemas>>(
  async (req, res) => {
    const result = await requestService.runHandlerStep(getAuthUser(req), req.params.id, {
      step: "accept",
      input: req.body,
    });
    sendStep(res, result, "accept");
  }
);

/** POST /api/requests/:id/reject — only while Requested; reason (the partner sees it). */
export const reject = asyncHandler<ValidatedRequest<typeof rejectRequestSchemas>>(
  async (req, res) => {
    const result = await requestService.runHandlerStep(getAuthUser(req), req.params.id, {
      step: "reject",
      input: req.body,
    });
    sendStep(res, result, "reject");
  }
);

/** POST /api/requests/:id/cancel — the handler cancels before Dispatched; reason. */
export const cancel = asyncHandler<ValidatedRequest<typeof cancelRequestSchemas>>(
  async (req, res) => {
    const result = await requestService.runHandlerStep(getAuthUser(req), req.params.id, {
      step: "cancel",
      input: req.body,
    });
    sendStep(res, result, "cancel");
  }
);

/** POST /api/requests/:id/payment-received and /refunded — date, mode, reference, receipt. */
export function moneyStep(step: "payment_received" | "refunded") {
  return asyncHandler<ValidatedRequest<typeof moneyStepSchemas>>(async (req, res) => {
    const result = await requestService.runHandlerStep(getAuthUser(req), req.params.id, {
      step,
      input: req.body,
    });
    sendStep(res, result, step);
  });
}

/** Steps with nothing to type: processing, dispatched, delivered, completed, refund-initiated. */
export function plainStep(
  step: "processing" | "dispatched" | "delivered" | "completed" | "refund_initiated"
) {
  return asyncHandler<ValidatedRequest<typeof plainStepSchemas>>(async (req, res) => {
    const result = await requestService.runHandlerStep(getAuthUser(req), req.params.id, {
      step,
    });
    sendStep(res, result, step);
  });
}

// ---------------------------------------------------------------------------
// T5: the ASM hands a request over — `requests.delegate` (DEC-171, DEC-172)
// ---------------------------------------------------------------------------

/** POST /api/requests/:id/assign — to one of my active Sales Executives; reason. */
export const assign = asyncHandler<ValidatedRequest<typeof assignRequestSchemas>>(
  async (req, res) => {
    const result = await requestService.runHandOver(getAuthUser(req), req.params.id, {
      kind: "assign",
      input: req.body,
    });
    const message = result.alreadyDone
      ? "This request is already with that Sales Executive"
      : `Request ${result.request.requestNo} given to ${result.request.handler.name ?? "the Sales Executive"}`;
    sendSuccess(res, 200, result, message);
  }
);

/** POST /api/requests/:id/take-back — the ASM handles it again; reason. */
export const takeBack = asyncHandler<ValidatedRequest<typeof takeBackRequestSchemas>>(
  async (req, res) => {
    const result = await requestService.runHandOver(getAuthUser(req), req.params.id, {
      kind: "take_back",
      input: req.body,
    });
    const message = result.alreadyDone
      ? "You are already handling this request"
      : `Request ${result.request.requestNo} taken back`;
    sendSuccess(res, 200, result, message);
  }
);

// ---------------------------------------------------------------------------
// T6: staff lists and details (DEC-173)
// ---------------------------------------------------------------------------

/** GET /api/requests/worklist — `requests.handle`: my (and my team's) requests. */
export const worklist = asyncHandler<ValidatedRequest<typeof worklistSchemas>>(async (req, res) => {
  const { items, meta } = await requestService.listWorklist(getAuthUser(req), req.query);
  sendSuccess(res, 200, items, undefined, meta);
});

/** GET /api/requests/:id — `requests.view` within scope: full details with the timeline. */
export const detail = asyncHandler<ValidatedRequest<typeof requestIdSchemas>>(async (req, res) => {
  const request = await requestService.getRequestForStaff(
    getAuthUser(req),
    getScope(req),
    req.params.id
  );
  sendSuccess(res, 200, request);
});

/** GET /api/partners/:id/requests — `requests.view` within scope: counts + list. */
export const partnerHistory = asyncHandler<ValidatedRequest<typeof partnerRequestsSchemas>>(
  async (req, res) => {
    const { counts, items, meta } = await requestService.listPartnerRequests(
      getAuthUser(req),
      getScope(req),
      req.params.id,
      req.query
    );
    sendSuccess(res, 200, { counts, items }, undefined, meta);
  }
);

/** POST /api/partner/requests/:id/cancel — cancel before Dispatched (Module 11 T3). */
export const cancelMine = asyncHandler<ValidatedRequest<typeof cancelRequestSchemas>>(
  async (req, res) => {
    const result = await requestService.cancelMyRequest(
      getAuthUser(req).id,
      req.params.id,
      req.body
    );
    const message = result.alreadyDone
      ? "This request was already cancelled"
      : `Request ${result.request.requestNo} cancelled`;
    sendSuccess(res, 200, result, message);
  }
);

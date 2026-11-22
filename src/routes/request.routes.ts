import { Router } from "express";
import * as requestController from "../controllers/request.controller.js";
import { requireApp, requireAuth } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import {
  allRequestsSchemas,
  assignRequestSchemas,
  takeBackRequestSchemas,
  acceptRequestSchemas,
  cancelRequestSchemas,
  moneyStepSchemas,
  plainStepSchemas,
  rejectRequestSchemas,
  requestIdSchemas,
  worklistSchemas,
} from "../validators/request.schema.js";

/**
 * Staff request screens (Module 11). Mounted at `/requests`. The partner's own routes are in
 * `partnerSelf.routes.ts` (`/partner/requests`).
 *
 * T4 — the handler's steps, `requests.handle` (DEC-164): a Sales Executive on the requests
 * they handle; an ASM on their own and their Sales Executives' requests. Admin, Sub-Admins
 * and Zonal Heads are view only. Out of reach → 404. Every step is permanent (DEC-162).
 */
const router = Router();

const handle = [requireAuth, requirePermission("requests.handle")];

// F9 T1 (DEC-279, DEC-280) — every request I may see, for the web panel only (Admin,
// Requests Sub-Admin, Zonal Head); ASM / Sales Executive use the worklist. All states by
// default, newest first.
router.get(
  "/",
  requireAuth,
  requireApp("web"),
  requirePermission("requests.view"),
  validate(allRequestsSchemas),
  requestController.listAll
);
// T6 (DEC-173) — the worklist: requests I handle (ASM: also my Sales Executives'), open by
// default, newest first. Before "/:id" so "worklist" isn't read as an id.
router.get("/worklist", ...handle, validate(worklistSchemas), requestController.worklist);
// Full details for any staff viewer within scope (`requests.view`): Admin / Requests
// Sub-Admin all, Zonal Head zone, ASM team + own partners, Sales Executive handled by them.
// Staff apps only: a partner holds `requests.view` (own) too, but sees their requests
// through /partner/requests, without staff names (DEC-169, DEC-280).
router.get(
  "/:id",
  requireAuth,
  requireApp("web", "field"),
  requirePermission("requests.view"),
  validate(requestIdSchemas),
  requestController.detail
);

router.post("/:id/accept", ...handle, validate(acceptRequestSchemas), requestController.accept);
router.post("/:id/reject", ...handle, validate(rejectRequestSchemas), requestController.reject);
router.post(
  "/:id/payment-received",
  ...handle,
  validate(moneyStepSchemas),
  requestController.moneyStep("payment_received")
);
router.post(
  "/:id/processing",
  ...handle,
  validate(plainStepSchemas),
  requestController.plainStep("processing")
);
router.post(
  "/:id/dispatched",
  ...handle,
  validate(plainStepSchemas),
  requestController.plainStep("dispatched")
);
router.post(
  "/:id/delivered",
  ...handle,
  validate(plainStepSchemas),
  requestController.plainStep("delivered")
);
router.post(
  "/:id/completed",
  ...handle,
  validate(plainStepSchemas),
  requestController.plainStep("completed")
);
router.post("/:id/cancel", ...handle, validate(cancelRequestSchemas), requestController.cancel);
router.post(
  "/:id/refund-initiated",
  ...handle,
  validate(plainStepSchemas),
  requestController.plainStep("refund_initiated")
);
router.post(
  "/:id/refunded",
  ...handle,
  validate(moneyStepSchemas),
  requestController.moneyStep("refunded")
);

// T5 — the ASM gives a request to one of their Sales Executives, moves it, or takes it back,
// at any open stage, with a reason (`requests.delegate`, ASM only; DEC-171, DEC-172).
const delegate = [requireAuth, requirePermission("requests.delegate")];
router.post("/:id/assign", ...delegate, validate(assignRequestSchemas), requestController.assign);
router.post(
  "/:id/take-back",
  ...delegate,
  validate(takeBackRequestSchemas),
  requestController.takeBack
);

export default router;

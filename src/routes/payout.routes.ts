import { Router } from "express";
import * as payoutController from "../controllers/payout.controller.js";
import { requireAuth } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import {
  approvePayoutSchemas,
  declinePayoutSchemas,
  editPaidDetailsSchemas,
  markFailedSchemas,
  markPaidSchemas,
  payoutIdSchemas,
  staffPayoutsSchemas,
} from "../validators/payout.schema.js";

/**
 * Staff payout screens (Module 10). Mounted at `/payouts`. The partner's own routes are in
 * `partnerSelf.routes.ts` (`/partner/payouts`).
 *
 * `payouts.approve` (approve, decline): Admin and the Rewards & Payouts Sub-Admin all
 * partners, Zonal Head their zone (DEC-045, DEC-154). Out of scope → 404.
 */
const router = Router();

// T5 (DEC-156): `payouts.view` — Admin / Rewards Sub-Admin all, Zonal Head zone, ASM own
// partners (incl. their SEs'), Sales Executive assigned partners. View only for ASM / SE.
router.get(
  "/",
  requireAuth,
  requirePermission("payouts.view"),
  validate(staffPayoutsSchemas),
  payoutController.list
);
router.get(
  "/:id",
  requireAuth,
  requirePermission("payouts.view"),
  validate(payoutIdSchemas),
  payoutController.detail
);

router.post(
  "/:id/approve",
  requireAuth,
  requirePermission("payouts.approve"),
  validate(approvePayoutSchemas),
  payoutController.approve
);
router.post(
  "/:id/decline",
  requireAuth,
  requirePermission("payouts.approve"),
  validate(declinePayoutSchemas),
  payoutController.decline
);

// T4 (DEC-155): paid and its corrections need `payouts.mark_paid`; failed needs
// `payouts.approve` (DEC-149).
router.post(
  "/:id/mark-paid",
  requireAuth,
  requirePermission("payouts.mark_paid"),
  validate(markPaidSchemas),
  payoutController.markPaid
);
router.patch(
  "/:id/paid-details",
  requireAuth,
  requirePermission("payouts.mark_paid"),
  validate(editPaidDetailsSchemas),
  payoutController.editPaidDetails
);
router.post(
  "/:id/mark-failed",
  requireAuth,
  requirePermission("payouts.approve"),
  validate(markFailedSchemas),
  payoutController.markFailed
);

export default router;

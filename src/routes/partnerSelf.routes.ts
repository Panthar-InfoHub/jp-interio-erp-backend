import { Router } from "express";
import { ROLE } from "../config/roles.js";
import * as partnerSelfController from "../controllers/partnerSelf.controller.js";
import * as payoutAccountController from "../controllers/payoutAccount.controller.js";
import { requireAuth, requireRole } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import {
  addMyAccountSchemas,
  editMyAccountSchemas,
  myAccountSchemas,
} from "../validators/payoutAccount.schema.js";
import { editMyProfileSchemas } from "../validators/partnerProfile.schema.js";

/**
 * The partner's own screens, in the Partner App (Module 5 T9). Partners only, on their
 * own record (`partner.self`). Mounted at `/partner`, after `/partner/onboarding`.
 * Guards are on each route (not `router.use`) so other `/partner/...` paths pass through.
 */
const router = Router();

const partnerOnly = [requireAuth, requireRole(ROLE.PARTNER), requirePermission("partner.self")];

router.get("/status", ...partnerOnly, partnerSelfController.status);

// My details, once verified (Module 5 T11, DEC-103). Not the phone: staff change it.
router.patch(
  "/profile",
  ...partnerOnly,
  validate(editMyProfileSchemas),
  partnerSelfController.editMyProfile
);

// My bank accounts / UPI IDs, once verified (Module 5 T10, DEC-101).
router.get("/payout-accounts", ...partnerOnly, payoutAccountController.listMine);
router.post(
  "/payout-accounts",
  ...partnerOnly,
  validate(addMyAccountSchemas),
  payoutAccountController.addMine
);
router.patch(
  "/payout-accounts/:accountId",
  ...partnerOnly,
  validate(editMyAccountSchemas),
  payoutAccountController.editMine
);
router.post(
  "/payout-accounts/:accountId/set-default",
  ...partnerOnly,
  validate(myAccountSchemas),
  payoutAccountController.setDefaultMine
);
router.post(
  "/payout-accounts/:accountId/remove",
  ...partnerOnly,
  validate(myAccountSchemas),
  payoutAccountController.removeMine
);

export default router;

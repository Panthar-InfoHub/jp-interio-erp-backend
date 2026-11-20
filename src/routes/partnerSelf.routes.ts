import { Router } from "express";
import { ROLE } from "../config/roles.js";
import * as partnerSelfController from "../controllers/partnerSelf.controller.js";
import * as payoutController from "../controllers/payout.controller.js";
import * as payoutAccountController from "../controllers/payoutAccount.controller.js";
import * as scanController from "../controllers/scan.controller.js";
import * as walletController from "../controllers/wallet.controller.js";
import { requireAuth, requireRole } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import { requireVerifiedPartner } from "../middlewares/verifiedPartner.js";
import {
  myPayoutsSchemas,
  payoutIdSchemas,
  requestPayoutSchemas,
} from "../validators/payout.schema.js";
import { myScansSchemas, scanSchemas } from "../validators/scan.schema.js";
import { myStatementSchemas } from "../validators/wallet.schema.js";
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

// My points wallet and statement, once verified (Module 8 T4, DEC-133).
const walletGuards = [
  requireAuth,
  requireRole(ROLE.PARTNER),
  requireVerifiedPartner,
  requirePermission("wallet.self"),
];
router.get("/wallet", ...walletGuards, walletController.myWallet);
router.get(
  "/wallet/statement",
  ...walletGuards,
  validate(myStatementSchemas),
  walletController.myStatement
);

// Scan a QR code and earn its points (Module 9 T2, DEC-138 – DEC-142).
router.post(
  "/scans",
  requireAuth,
  requireRole(ROLE.PARTNER),
  requireVerifiedPartner,
  requirePermission("scans.create"),
  validate(scanSchemas),
  scanController.scan
);
// My scan history (Module 9 T4, DEC-145): same guards as the wallet.
router.get("/scans", ...walletGuards, validate(myScansSchemas), scanController.myScans);

// Ask for a payout (Module 10 T2, DEC-149 – DEC-153). Needs an `Idempotency-Key` header.
router.post(
  "/payouts",
  requireAuth,
  requireRole(ROLE.PARTNER),
  requireVerifiedPartner,
  requirePermission("payouts.request"),
  validate(requestPayoutSchemas),
  payoutController.request
);
// My payouts and one payout (Module 10 T5, DEC-156): same guards as asking for one.
const payoutGuards = [
  requireAuth,
  requireRole(ROLE.PARTNER),
  requireVerifiedPartner,
  requirePermission("payouts.request"),
];
router.get("/payouts", ...payoutGuards, validate(myPayoutsSchemas), payoutController.myPayouts);
router.get("/payouts/:id", ...payoutGuards, validate(payoutIdSchemas), payoutController.myPayout);

export default router;

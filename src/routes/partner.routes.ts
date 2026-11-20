import { Router } from "express";
import * as partnerController from "../controllers/partner.controller.js";
import * as partnerSelfController from "../controllers/partnerSelf.controller.js";
import * as payoutAccountController from "../controllers/payoutAccount.controller.js";
import * as requestController from "../controllers/request.controller.js";
import * as scanController from "../controllers/scan.controller.js";
import * as walletController from "../controllers/wallet.controller.js";
import { requireAuth } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import {
  assignSalesExecutiveSchemas,
  listPartnersSchemas,
  numberLookupSchemas,
  partner360Schemas,
  partnerIdSchemas,
  removeDraftSchemas,
  transferPartnerSchemas,
} from "../validators/partner.schema.js";
import {
  addPartnerAccountSchemas,
  editPartnerAccountSchemas,
  partnerAccountSchemas,
  partnerAccountsSchemas,
} from "../validators/payoutAccount.schema.js";
import {
  changePhoneSchemas,
  editPartnerProfileSchemas,
} from "../validators/partnerProfile.schema.js";
import { pointsAdjustmentSchemas } from "../validators/pointsAdjustment.schema.js";
import { partnerRequestsSchemas } from "../validators/request.schema.js";
import { partnerScansSchemas } from "../validators/scan.schema.js";
import { partnerLedgerSchemas, partnerWalletSchemas } from "../validators/wallet.schema.js";

/**
 * Partners. Module 4 Task 9 (DEC-069):
 * - assign / unassign a Sales Executive: `team.assign_partners` (ASM, own partners)
 * - move to another ASM: `partners.transfer` (Zonal Head own zone, Admin any zone)
 * Module 5 adds onboarding, KYC and the partner list.
 */
const router = Router();

router.use(requireAuth);

// Partner list (verified only) and Partner 360 (any state) — Module 5 T13, DEC-105.
router.get(
  "/",
  requirePermission("partners.view"),
  validate(listPartnersSchemas),
  partnerController.list
);
router.get(
  "/:id",
  requirePermission("partners.view"),
  validate(partner360Schemas),
  partnerController.get360
);

router.post(
  "/:id/assign-sales-executive",
  requirePermission("team.assign_partners"),
  validate(assignSalesExecutiveSchemas),
  partnerController.assignSalesExecutive
);
router.post(
  "/:id/unassign-sales-executive",
  requirePermission("team.assign_partners"),
  validate(partnerIdSchemas),
  partnerController.unassignSalesExecutive
);
router.post(
  "/:id/transfer",
  requirePermission("partners.transfer"),
  validate(transferPartnerSchemas),
  partnerController.transfer
);

// A verified partner's details and phone (Module 5 T11, DEC-103): SE, ASM, ZH, Sub-Admin, Admin.
router.patch(
  "/:id/profile",
  requirePermission("partners.edit"),
  validate(editPartnerProfileSchemas),
  partnerSelfController.editPartnerProfile
);
router.post(
  "/:id/change-phone",
  requirePermission("partners.edit"),
  validate(changePhoneSchemas),
  partnerSelfController.changePhone
);

// A partner's bank accounts / UPI IDs (Module 5 T10, DEC-101): SE, ASM, ZH, Sub-Admin, Admin.
router.get(
  "/:id/payout-accounts",
  requirePermission("partners.payout_accounts"),
  validate(partnerAccountsSchemas),
  payoutAccountController.listForPartner
);
router.post(
  "/:id/payout-accounts",
  requirePermission("partners.payout_accounts"),
  validate(addPartnerAccountSchemas),
  payoutAccountController.addForPartner
);
router.patch(
  "/:id/payout-accounts/:accountId",
  requirePermission("partners.payout_accounts"),
  validate(editPartnerAccountSchemas),
  payoutAccountController.editForPartner
);
router.post(
  "/:id/payout-accounts/:accountId/set-default",
  requirePermission("partners.payout_accounts"),
  validate(partnerAccountSchemas),
  payoutAccountController.setDefaultForPartner
);
router.post(
  "/:id/payout-accounts/:accountId/remove",
  requirePermission("partners.payout_accounts"),
  validate(partnerAccountSchemas),
  payoutAccountController.removeForPartner
);

// A partner's points (Module 8 T5, DEC-134): `ledger.view` within scope.
router.get(
  "/:id/wallet",
  requirePermission("ledger.view"),
  validate(partnerWalletSchemas),
  walletController.partnerWallet
);
router.get(
  "/:id/ledger",
  requirePermission("ledger.view"),
  validate(partnerLedgerSchemas),
  walletController.partnerLedger
);
// A partner's scans (Module 9 T4, DEC-145): `scans.view` within scope.
router.get(
  "/:id/scans",
  requirePermission("scans.view"),
  validate(partnerScansSchemas),
  scanController.partnerScans
);
// A partner's shipment / sample requests (Module 11 T6, DEC-173): `requests.view` within scope.
router.get(
  "/:id/requests",
  requirePermission("requests.view"),
  validate(partnerRequestsSchemas),
  requestController.partnerHistory
);
// Manual credit / debit with a reason (Module 8 T6): Admin and Rewards Sub-Admin.
router.post(
  "/:id/points-adjustment",
  requirePermission("ledger.adjust"),
  validate(pointsAdjustmentSchemas),
  walletController.adjustPoints
);

// Admin only (Module 5 T7, DEC-096, DEC-097).
router.post(
  "/number-lookup",
  requirePermission("partners.remove_draft"),
  validate(numberLookupSchemas),
  partnerController.numberLookup
);
router.post(
  "/:id/remove-draft",
  requirePermission("partners.remove_draft"),
  validate(removeDraftSchemas),
  partnerController.removeDraft
);

export default router;

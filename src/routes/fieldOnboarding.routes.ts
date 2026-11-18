import { Router } from "express";
import { ROLE } from "../config/roles.js";
import * as fieldOnboardingController from "../controllers/fieldOnboarding.controller.js";
import { requireAuth, requireRole } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import {
  fieldBasicInfoSchemas,
  fieldFirmDetailsSchemas,
  fieldKycSchemas,
  fieldPartnerSchemas,
  fieldPayoutAccountSchemas,
  fieldStartSchemas,
  fieldVerifySchemas,
} from "../validators/onboarding.schema.js";

/**
 * Field onboarding, in the Field Sales App (Module 5 T5, DEC-090 – DEC-092).
 * ASMs and Sales Executives only (`partners.onboard`). A staff member only sees the
 * onboardings they started; anything else is 404.
 */
const router = Router();

router.use(
  requireAuth,
  requireRole(ROLE.ASM, ROLE.SALES_EXECUTIVE),
  requirePermission("partners.onboard")
);

router.post("/start", validate(fieldStartSchemas), fieldOnboardingController.start);
router.post("/verify", validate(fieldVerifySchemas), fieldOnboardingController.verify);
router.get("/drafts", fieldOnboardingController.listDrafts);
router.get("/:partnerId", validate(fieldPartnerSchemas), fieldOnboardingController.get);
router.put(
  "/:partnerId/basic-info",
  validate(fieldBasicInfoSchemas),
  fieldOnboardingController.saveBasicInfo
);
router.put(
  "/:partnerId/firm-details",
  validate(fieldFirmDetailsSchemas),
  fieldOnboardingController.saveFirmDetails
);
router.post(
  "/:partnerId/payout-account",
  validate(fieldPayoutAccountSchemas),
  fieldOnboardingController.savePayoutAccount
);
router.put("/:partnerId/kyc", validate(fieldKycSchemas), fieldOnboardingController.saveKyc);
router.post("/:partnerId/submit", validate(fieldPartnerSchemas), fieldOnboardingController.submit);

export default router;

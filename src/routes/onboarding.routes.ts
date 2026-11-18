import { Router } from "express";
import { ROLE } from "../config/roles.js";
import * as onboardingController from "../controllers/onboarding.controller.js";
import { requireAuth, requireRole } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import {
  basicInfoSchemas,
  firmDetailsSchemas,
  kycSchemas,
  payoutAccountSchemas,
} from "../validators/onboarding.schema.js";

/**
 * Partner self sign-up, in the Partner App (Module 5 T4, DEC-079 – DEC-089).
 * Partners only, on their own record (`partner.self`).
 * Steps are forward only; the service refuses a step that is not the current one.
 */
const router = Router();

router.use(requireAuth, requireRole(ROLE.PARTNER), requirePermission("partner.self"));

router.get("/zones", onboardingController.listZones);
router.get("/", onboardingController.get);
router.put("/basic-info", validate(basicInfoSchemas), onboardingController.saveBasicInfo);
router.put("/firm-details", validate(firmDetailsSchemas), onboardingController.saveFirmDetails);
router.post(
  "/payout-account",
  validate(payoutAccountSchemas),
  onboardingController.savePayoutAccount
);
router.put("/kyc", validate(kycSchemas), onboardingController.saveKyc);
router.post("/submit", onboardingController.submit);

export default router;

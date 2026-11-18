import { Router } from "express";
import { ROLE } from "../config/roles.js";
import * as kycController from "../controllers/kyc.controller.js";
import { requireAuth, requireRole } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import {
  approveKycSchemas,
  kycPartnerSchemas,
  kycQueueSchemas,
  rejectKycSchemas,
  undoRejectionSchemas,
} from "../validators/kyc.schema.js";

/**
 * KYC queue (Module 5 T8; DEC-073, DEC-074, DEC-098).
 * `kyc.verify`: Zonal Head (own zone), Partners & KYC Sub-Admin and Admin (all zones).
 * Undo a rejection: Admin only (DEC-074).
 */
const router = Router();

router.use(requireAuth, requirePermission("kyc.verify"));

router.get("/queue", validate(kycQueueSchemas), kycController.queue);
router.get("/:id", validate(kycPartnerSchemas), kycController.get);
router.post("/:id/approve", validate(approveKycSchemas), kycController.approve);
router.post("/:id/reject", validate(rejectKycSchemas), kycController.reject);
router.post(
  "/:id/undo-rejection",
  requireRole(ROLE.ADMIN),
  validate(undoRejectionSchemas),
  kycController.undoRejection
);

export default router;

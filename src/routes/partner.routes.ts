import { Router } from "express";
import * as partnerController from "../controllers/partner.controller.js";
import { requireAuth } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import {
  assignSalesExecutiveSchemas,
  partnerIdSchemas,
  transferPartnerSchemas,
} from "../validators/partner.schema.js";

/**
 * Partners. Module 4 Task 9 (DEC-069):
 * - assign / unassign a Sales Executive: `team.assign_partners` (ASM, own partners)
 * - move to another ASM: `partners.transfer` (Zonal Head own zone, Admin any zone)
 * Module 5 adds onboarding, KYC and the partner list.
 */
const router = Router();

router.use(requireAuth);

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

export default router;

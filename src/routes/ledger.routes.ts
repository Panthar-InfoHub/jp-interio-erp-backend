import { Router } from "express";
import * as walletController from "../controllers/wallet.controller.js";
import { requireAuth } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import { ledgerSchemas } from "../validators/wallet.schema.js";

/**
 * The points ledger across partners (Module 8 T5, DEC-134). `ledger.view`: Admin and the
 * Rewards Sub-Admin all partners, Zonal Head their zone, ASM their partners (incl. their
 * SEs'), Sales Executive their assigned partners. Mounted at `/ledger`.
 */
const router = Router();

router.get(
  "/",
  requireAuth,
  requirePermission("ledger.view"),
  validate(ledgerSchemas),
  walletController.ledger
);

export default router;

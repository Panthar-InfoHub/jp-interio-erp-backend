import { Router } from "express";
import * as dashboardController from "../controllers/dashboard.controller.js";
import { requireAuth } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import { dashboardSchemas } from "../validators/dashboard.schema.js";

/**
 * Dashboards (Module 16). One address for every staff role (DEC-220): the server returns
 * only the caller's cards. Web console (Admin, Sub-Admin, Zonal Head) and field app (ASM,
 * Sales Executive, DEC-204), so no app check. Partners have no `dashboard.view` (DEC-197).
 * Mounted at `/dashboard`.
 */
const router = Router();

router.get(
  "/",
  requireAuth,
  requirePermission("dashboard.view"),
  validate(dashboardSchemas),
  dashboardController.mine
);

export default router;

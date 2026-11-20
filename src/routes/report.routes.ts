import { Router } from "express";
import * as reportController from "../controllers/report.controller.js";
import { requireAuth } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import { pointsLiabilitySchemas } from "../validators/report.schema.js";

/**
 * Reports. Module 8 T7 adds the points liability report (Admin only, DEC-045, DEC-136).
 * The reports module (later) adds the rest. Mounted at `/reports`.
 */
const router = Router();

router.use(requireAuth);

router.get(
  "/points-liability",
  requirePermission("reports.points_liability"),
  validate(pointsLiabilitySchemas),
  reportController.pointsLiability
);

export default router;

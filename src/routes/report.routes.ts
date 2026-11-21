import { Router } from "express";
import * as reportController from "../controllers/report.controller.js";
import { requireApp, requireAuth } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import {
  pointsLiabilitySchemas,
  REPORT_KEYS,
  reportQuerySchemas,
} from "../validators/report.schema.js";

/**
 * Reports. Module 8 T7 adds the points liability report (Admin and, since Module 16, the
 * Rewards Sub-Admin: DEC-136, DEC-205). Module 16 adds the CSV reports. Mounted at `/reports`.
 */
const router = Router();

router.use(requireAuth);

router.get(
  "/points-liability",
  requirePermission("reports.points_liability"),
  validate(pointsLiabilitySchemas),
  reportController.pointsLiability
);

// The 8 CSV reports (Module 16 T5, DEC-224): `/reports/scans.csv`, `/reports/payouts.csv`, …
// Admin, Sub-Admin (their areas, checked in the service) and Zonal Head (own zone). Web only.
for (const key of REPORT_KEYS) {
  router.get(
    `/${key}.csv`,
    requireApp("web"),
    requirePermission("reports.view"),
    validate({ query: reportQuerySchemas[key] }),
    reportController.downloadReport(key)
  );
}

export default router;

import { Router } from "express";
import * as internalJobsController from "../controllers/internalJobs.controller.js";
import { requireCronSecret } from "../middlewares/cronSecret.js";

/**
 * Internal endpoints for the hosting scheduler only (DEC-313). Not for any app or the
 * panel, and not in the Apidog files. Locked by `CRON_SECRET` (`requireCronSecret`).
 * Mounted at `/internal`.
 */
const router = Router();

router.post("/jobs/escalate-tasks", requireCronSecret, internalJobsController.escalateTasks);
router.post("/jobs/clean-drafts", requireCronSecret, internalJobsController.cleanDrafts);

export default router;

import { logger } from "../lib/logger.js";
import { removeExpiredDrafts } from "../services/draftCleanup.service.js";
import { escalateOverdueTasks } from "../services/taskEscalation.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * Nightly jobs run over HTTP by the hosting scheduler (DEC-313). They call the same
 * services as `npm run job:escalate-tasks` / `job:clean-drafts`; both are safe to run
 * twice (a task is flagged once, a draft retired once), so a scheduler retry does no harm.
 */

/** POST /api/internal/jobs/escalate-tasks — flag overdue tasks to the doer's manager. */
export const escalateTasks = asyncHandler(async (_req, res) => {
  const result = await escalateOverdueTasks();
  logger.info({ result }, "Overdue task check (scheduler)");
  sendSuccess(res, 200, result, "Overdue task check done");
});

/** POST /api/internal/jobs/clean-drafts — retire unfinished sign-ups older than the setting. */
export const cleanDrafts = asyncHandler(async (_req, res) => {
  const result = await removeExpiredDrafts();
  logger.info({ result }, "Draft clean-up (scheduler)");
  sendSuccess(res, 200, result, "Draft clean-up done");
});

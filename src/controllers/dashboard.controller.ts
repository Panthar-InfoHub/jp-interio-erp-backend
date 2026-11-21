import { getAuthUser } from "../middlewares/auth.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import * as dashboardService from "../services/dashboard.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import type { dashboardSchemas } from "../validators/dashboard.schema.js";

/**
 * GET /api/dashboard?period=today|month|all&rankAsmsBy=points|scans|newPartners — my
 * dashboard (Module 16, DEC-220).
 */
export const mine = asyncHandler<ValidatedRequest<typeof dashboardSchemas>>(async (req, res) => {
  sendSuccess(res, 200, await dashboardService.getDashboard(getAuthUser(req), req.query));
});

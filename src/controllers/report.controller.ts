import type { ValidatedRequest } from "../middlewares/validate.js";
import * as reportService from "../services/report.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import type { pointsLiabilitySchemas } from "../validators/report.schema.js";

/** GET /api/reports/points-liability — Admin only (Module 8 T7, DEC-136). */
export const pointsLiability = asyncHandler<ValidatedRequest<typeof pointsLiabilitySchemas>>(
  async (req, res) => {
    sendSuccess(res, 200, await reportService.getPointsLiability(req.query.asOf));
  }
);

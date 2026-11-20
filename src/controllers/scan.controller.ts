import { getAuthUser } from "../middlewares/auth.js";
import { getScope } from "../middlewares/permission.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import * as scanService from "../services/scan.service.js";
import * as scanHistoryService from "../services/scanHistory.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import type {
  myScansSchemas,
  partnerScansSchemas,
  scanSchemas,
} from "../validators/scan.schema.js";

/**
 * POST /api/partner/scans — scan a QR code and earn its points (Module 9 T2).
 * 201 for a new scan; 200 for a retry of a scan already counted (no new points).
 */
export const scan = asyncHandler<ValidatedRequest<typeof scanSchemas>>(async (req, res) => {
  const result = await scanService.scanCode(getAuthUser(req), req.body);
  if (result.alreadyCounted) {
    sendSuccess(res, 200, result, "This scan was already counted");
  } else {
    sendSuccess(res, 201, result, `${result.scan.points} points added`);
  }
});

/** GET /api/partner/scans — my scans, newest first, paged, with totals (Module 9 T4). */
export const myScans = asyncHandler<ValidatedRequest<typeof myScansSchemas>>(async (req, res) => {
  const { items, meta } = await scanHistoryService.getMyScans(getAuthUser(req).id, req.query);
  sendSuccess(res, 200, items, undefined, meta);
});

/** GET /api/partners/:id/scans — one partner's scans, `scans.view` within scope (T4). */
export const partnerScans = asyncHandler<ValidatedRequest<typeof partnerScansSchemas>>(
  async (req, res) => {
    const { items, meta } = await scanHistoryService.getPartnerScans(
      getAuthUser(req),
      getScope(req),
      req.params.id,
      req.query
    );
    sendSuccess(res, 200, items, undefined, meta);
  }
);

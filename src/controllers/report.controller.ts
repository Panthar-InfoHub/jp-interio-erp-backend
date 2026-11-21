import type { RequestHandler } from "express";
import { getAuthUser } from "../middlewares/auth.js";
import { getScope } from "../middlewares/permission.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import * as reportService from "../services/report.service.js";
import { startReportDownload } from "../services/reportExport.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { writeCsv } from "../utils/csv.js";
import type {
  pointsLiabilitySchemas,
  ReportKey,
  ReportQuery,
} from "../validators/report.schema.js";

/**
 * GET /api/reports/<key>.csv — one CSV report (Module 16 T5, DEC-224). Access is checked and
 * the audit row written before any byte is sent; then the file streams.
 */
export function downloadReport(key: ReportKey): RequestHandler {
  return asyncHandler(async (req, res) => {
    const download = await startReportDownload(
      getAuthUser(req),
      getScope(req),
      key,
      req.query as ReportQuery[typeof key]
    );
    res.status(200);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${download.filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Row-Count", String(download.rowCount));
    await writeCsv(res, download.header, download.batches);
  });
}

/** GET /api/reports/points-liability — Admin and Rewards Sub-Admin (DEC-136, DEC-205). */
export const pointsLiability = asyncHandler<ValidatedRequest<typeof pointsLiabilitySchemas>>(
  async (req, res) => {
    sendSuccess(res, 200, await reportService.getPointsLiability(req.query.asOf));
  }
);

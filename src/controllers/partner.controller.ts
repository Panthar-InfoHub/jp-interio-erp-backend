import { getAuthUser } from "../middlewares/auth.js";
import { getScope } from "../middlewares/permission.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import * as partnerService from "../services/partner.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import type {
  assignSalesExecutiveSchemas,
  partnerIdSchemas,
  transferPartnerSchemas,
} from "../validators/partner.schema.js";

/** POST /api/partners/:id/assign-sales-executive — ASM (DEC-069). */
export const assignSalesExecutive = asyncHandler<
  ValidatedRequest<typeof assignSalesExecutiveSchemas>
>(async (req, res) => {
  const { partner, changed } = await partnerService.assignSalesExecutive(
    getAuthUser(req),
    getScope(req),
    req.params.id,
    req.body.salesExecutiveId
  );
  sendSuccess(res, 200, partner, changed ? "Sales Executive assigned" : "No change");
});

/** POST /api/partners/:id/unassign-sales-executive — ASM (DEC-069). */
export const unassignSalesExecutive = asyncHandler<ValidatedRequest<typeof partnerIdSchemas>>(
  async (req, res) => {
    const { partner, changed } = await partnerService.unassignSalesExecutive(
      getAuthUser(req),
      getScope(req),
      req.params.id
    );
    sendSuccess(res, 200, partner, changed ? "Sales Executive removed" : "No change");
  }
);

/** POST /api/partners/:id/transfer — Zonal Head (own zone) or Admin (DEC-069). */
export const transfer = asyncHandler<ValidatedRequest<typeof transferPartnerSchemas>>(
  async (req, res) => {
    const { partner, salesExecutiveCleared } = await partnerService.transferPartner(
      getAuthUser(req),
      getScope(req),
      req.params.id,
      req.body.asmId
    );
    const message = salesExecutiveCleared
      ? "Partner moved. Their Sales Executive was removed."
      : "Partner moved";
    sendSuccess(res, 200, partner, message);
  }
);

import { getAuthUser } from "../middlewares/auth.js";
import { getScope } from "../middlewares/permission.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import * as draftCleanupService from "../services/draftCleanup.service.js";
import * as numberLookupService from "../services/numberLookup.service.js";
import * as partnerService from "../services/partner.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import type {
  assignSalesExecutiveSchemas,
  listPartnersSchemas,
  numberLookupSchemas,
  partner360Schemas,
  partnerIdSchemas,
  removeDraftSchemas,
  transferPartnerSchemas,
} from "../validators/partner.schema.js";

/** GET /api/partners — verified partners in my scope (DEC-105). */
export const list = asyncHandler<ValidatedRequest<typeof listPartnersSchemas>>(async (req, res) => {
  const { items, meta } = await partnerService.listPartners(
    getAuthUser(req),
    getScope(req),
    req.query
  );
  sendSuccess(res, 200, items, undefined, meta);
});

/** GET /api/partners/:id — Partner 360, any state (DEC-105). */
export const get360 = asyncHandler<ValidatedRequest<typeof partner360Schemas>>(async (req, res) => {
  sendSuccess(
    res,
    200,
    await partnerService.getPartner360(getAuthUser(req), getScope(req), req.params.id)
  );
});

/** POST /api/partners/number-lookup — Admin: who holds this number (DEC-097). */
export const numberLookup = asyncHandler<ValidatedRequest<typeof numberLookupSchemas>>(
  async (req, res) => {
    const data = await numberLookupService.findNumberHolder(req.body);
    sendSuccess(res, 200, data, data.found ? "Number found" : "Nobody holds this number");
  }
);

/** POST /api/partners/:id/remove-draft — Admin: remove an unfinished draft now (DEC-096). */
export const removeDraft = asyncHandler<ValidatedRequest<typeof removeDraftSchemas>>(
  async (req, res) => {
    const data = await draftCleanupService.removeDraftNow(
      getAuthUser(req),
      req.params.id,
      req.body.reason
    );
    sendSuccess(res, 200, data, "Draft removed. Its phone and numbers are free again.");
  }
);

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

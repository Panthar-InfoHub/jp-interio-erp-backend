import { getAuthUser } from "../middlewares/auth.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import * as subAdminService from "../services/subAdmin.service.js";
import type { idParams } from "../validators/common.js";
import type { setAreasSchemas } from "../validators/subAdmin.schema.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/** GET /api/sub-admins — every Sub-Admin with their areas. */
export const list = asyncHandler(async (_req, res) => {
  sendSuccess(res, 200, await subAdminService.listSubAdmins());
});

/** GET /api/sub-admins/:id/areas — one Sub-Admin's areas. */
export const getAreas = asyncHandler<ValidatedRequest<{ params: typeof idParams }>>(
  async (req, res) => {
    sendSuccess(res, 200, await subAdminService.getAreas(req.params.id));
  }
);

/** PUT /api/sub-admins/:id/areas — { areas: [...] }, the full list. */
export const setAreas = asyncHandler<ValidatedRequest<typeof setAreasSchemas>>(async (req, res) => {
  const result = await subAdminService.setAreas(getAuthUser(req), req.params.id, req.body.areas);
  sendSuccess(res, 200, result, result.changed ? "Areas updated" : "No change");
});

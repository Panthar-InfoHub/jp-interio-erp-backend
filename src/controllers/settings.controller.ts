import { getAuthUser } from "../middlewares/auth.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import * as settingsService from "../services/settings.service.js";
import type { updateSettingSchemas } from "../validators/settings.schema.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/** GET /api/settings — every setting with its value and limits (DEC-054). */
export const list = asyncHandler(async (_req, res) => {
  sendSuccess(res, 200, await settingsService.listSettings());
});

/** PATCH /api/settings/:key — { value }. */
export const update = asyncHandler<ValidatedRequest<typeof updateSettingSchemas>>(
  async (req, res) => {
    const result = await settingsService.updateSetting(
      getAuthUser(req),
      req.params.key,
      req.body.value
    );
    sendSuccess(res, 200, result, result.changed ? "Setting updated" : "No change");
  }
);

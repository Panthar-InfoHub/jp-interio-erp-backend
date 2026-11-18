import { getAuthUser } from "../middlewares/auth.js";
import { getScope } from "../middlewares/permission.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import * as partnerProfileService from "../services/partnerProfile.service.js";
import * as partnerStatusService from "../services/partnerStatus.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import type {
  changePhoneSchemas,
  editMyProfileSchemas,
  editPartnerProfileSchemas,
} from "../validators/partnerProfile.schema.js";

/** PATCH /api/partner/profile — the partner edits their own details (DEC-103). */
export const editMyProfile = asyncHandler<ValidatedRequest<typeof editMyProfileSchemas>>(
  async (req, res) => {
    const user = getAuthUser(req);
    const data = await partnerProfileService.editProfile(user, getScope(req), user.id, req.body);
    sendSuccess(res, 200, data, data.changed ? "Details updated" : "No change");
  }
);

/** PATCH /api/partners/:id/profile — staff edit a partner's details (DEC-103). */
export const editPartnerProfile = asyncHandler<ValidatedRequest<typeof editPartnerProfileSchemas>>(
  async (req, res) => {
    const data = await partnerProfileService.editProfile(
      getAuthUser(req),
      getScope(req),
      req.params.id,
      req.body
    );
    sendSuccess(res, 200, data, data.changed ? "Details updated" : "No change");
  }
);

/** POST /api/partners/:id/change-phone — staff only, no OTP, partner logged out (DEC-074). */
export const changePhone = asyncHandler<ValidatedRequest<typeof changePhoneSchemas>>(
  async (req, res) => {
    const data = await partnerProfileService.changePhone(
      getAuthUser(req),
      getScope(req),
      req.params.id,
      req.body.phone
    );
    sendSuccess(res, 200, data, "Phone number changed. The partner has been logged out.");
  }
);

/** The partner's own screens in the Partner App (Module 5 T9; T11 adds the profile). */

/** GET /api/partner/status — which screen to show, and whom to contact (DEC-100). */
export const status = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, await partnerStatusService.getMyStatus(getAuthUser(req).id));
});

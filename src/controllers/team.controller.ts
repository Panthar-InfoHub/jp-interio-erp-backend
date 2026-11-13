import { getAuthUser } from "../middlewares/auth.js";
import * as teamService from "../services/team.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/** GET /api/team — the ASM's Sales Executives and partner counts (DEC-068). */
export const getMyTeam = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, await teamService.getMyTeam(getAuthUser(req)));
});

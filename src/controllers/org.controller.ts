import { getAuthUser } from "../middlewares/auth.js";
import { getScope } from "../middlewares/permission.js";
import * as orgService from "../services/org.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/** GET /api/org/tree — the hierarchy as a tree, scoped (DEC-070). */
export const getTree = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, await orgService.getOrgTree(getAuthUser(req), getScope(req)));
});

import { getAuthUser } from "../middlewares/auth.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import * as storageService from "../services/storage.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import type { uploadLinkSchemas } from "../validators/upload.schema.js";

/** POST /api/uploads/upload-link — a 5-minute link to upload one file straight to R2 (DEC-084). */
export const createUploadLink = asyncHandler<ValidatedRequest<typeof uploadLinkSchemas>>(
  async (req, res) => {
    sendSuccess(res, 201, await storageService.createUploadLink(getAuthUser(req), req.body));
  }
);

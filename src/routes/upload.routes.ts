import { Router } from "express";
import * as uploadController from "../controllers/upload.controller.js";
import { requireAuth } from "../middlewares/auth.js";
import { validate } from "../middlewares/validate.js";
import { uploadLinkSchemas } from "../validators/upload.schema.js";

/**
 * File uploads (DEC-084). Any logged-in user may ask; who may upload for each purpose
 * is checked in the storage service (config/uploads.ts). Works the same from the
 * mobile apps and, later, the web console (needs a CORS rule on the bucket).
 */
const router = Router();

router.post(
  "/upload-link",
  requireAuth,
  validate(uploadLinkSchemas),
  uploadController.createUploadLink
);

export default router;

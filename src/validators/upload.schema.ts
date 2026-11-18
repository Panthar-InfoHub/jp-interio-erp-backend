import { z } from "zod";
import { ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES, UPLOAD_PURPOSES } from "../config/uploads.js";
import type { RequestSchemas } from "../middlewares/validate.js";

const purposes = Object.keys(UPLOAD_PURPOSES) as [keyof typeof UPLOAD_PURPOSES];
const contentTypes = Object.keys(ALLOWED_CONTENT_TYPES) as [keyof typeof ALLOWED_CONTENT_TYPES];

/** POST /api/uploads/upload-link */
export const uploadLinkSchemas = {
  body: z.object({
    purpose: z.enum(purposes),
    contentType: z.enum(contentTypes, "must be a PDF or an image (JPG, PNG, WebP, HEIC)"),
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(MAX_UPLOAD_BYTES, "the file must be 10 MB or smaller"),
  }),
} satisfies RequestSchemas;

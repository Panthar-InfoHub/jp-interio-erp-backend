import { z } from "zod";
import {
  ALLOWED_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  UPLOAD_PURPOSES,
  sizeLabel,
  uploadRule,
} from "../config/uploads.js";
import type { RequestSchemas } from "../middlewares/validate.js";

const purposes = Object.keys(UPLOAD_PURPOSES) as [keyof typeof UPLOAD_PURPOSES];
const contentTypes = Object.keys(ALLOWED_CONTENT_TYPES) as [keyof typeof ALLOWED_CONTENT_TYPES];

/**
 * POST /api/uploads/upload-link
 * Type and size are checked against the purpose's own rule (config/uploads.ts, DEC-113):
 * e.g. KYC allows PDFs up to 10 MB, product images only JPG / PNG / WebP up to 5 MB.
 */
export const uploadLinkSchemas = {
  body: z
    .object({
      purpose: z.enum(purposes),
      contentType: z.enum(contentTypes, "must be a PDF or an image (JPG, PNG, WebP, HEIC)"),
      sizeBytes: z
        .number()
        .int()
        .positive()
        .max(MAX_UPLOAD_BYTES, `the file must be ${sizeLabel(MAX_UPLOAD_BYTES)} or smaller`),
    })
    .superRefine((body, ctx) => {
      const rule = uploadRule(body.purpose);
      if (!rule.contentTypes.includes(body.contentType)) {
        ctx.addIssue({
          code: "custom",
          path: ["contentType"],
          message: `must be ${rule.typesLabel}`,
        });
      }
      if (body.sizeBytes > rule.maxBytes) {
        ctx.addIssue({
          code: "custom",
          path: ["sizeBytes"],
          message: `the file must be ${sizeLabel(rule.maxBytes)} or smaller`,
        });
      }
    }),
} satisfies RequestSchemas;

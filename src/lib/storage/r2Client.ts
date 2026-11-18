import { S3Client } from "@aws-sdk/client-s3";
import { env } from "../../config/env.js";

/**
 * Cloudflare R2 speaks the Amazon S3 language, so we use the S3 library (DEC-084).
 * Region is always "auto" for R2. The keys come from .env and are never logged.
 */
export const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

export const R2_BUCKET = env.R2_BUCKET;

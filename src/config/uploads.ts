import { ROLE, type RoleId } from "./roles.js";

/**
 * What files can be uploaded, and for what (Module 5 T3, DEC-074, DEC-084).
 * Later modules add a purpose here (task photos, ticket photos, product images).
 */

/** Maximum file size: 10 MB (DEC-074). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** How long a signed upload link works. */
export const UPLOAD_LINK_SECONDS = 5 * 60;

/** Allowed file types → the file extension used in the file name (DEC-075: PDF and images). */
export const ALLOWED_CONTENT_TYPES = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
} as const;

export type AllowedContentType = keyof typeof ALLOWED_CONTENT_TYPES;

/** Each purpose: its folder in the bucket and which roles may upload for it. */
export const UPLOAD_PURPOSES = {
  /** PAN / Aadhaar photos and the GST certificate: the partner (self sign-up) or field staff. */
  kyc: { folder: "kyc", roles: [ROLE.PARTNER, ROLE.ASM, ROLE.SALES_EXECUTIVE] },
} as const satisfies Record<string, { folder: string; roles: readonly RoleId[] }>;

export type UploadPurpose = keyof typeof UPLOAD_PURPOSES;

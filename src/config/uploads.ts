import type { Capability } from "./capabilities.js";
import { ROLE, type RoleId } from "./roles.js";

/**
 * What files can be uploaded, and for what (Module 5 T3, DEC-074, DEC-084; Module 6 T4, DEC-113).
 * Module 10 T4 adds `payout_proof` (DEC-155); Module 11 T4 `request_receipt` (DEC-170).
 * Module 12 T3 `task_photo` (DEC-181). Later modules add more (ticket photos).
 */

const MB = 1024 * 1024;

/** The largest size any purpose allows (10 MB, KYC). Each purpose has its own limit below. */
export const MAX_UPLOAD_BYTES = 10 * MB;

/** How long a signed upload link works. */
export const UPLOAD_LINK_SECONDS = 5 * 60;

/** Every file type we know → the file extension used in the file name. */
export const ALLOWED_CONTENT_TYPES = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
} as const;

export type AllowedContentType = keyof typeof ALLOWED_CONTENT_TYPES;

type UploadRule = {
  /** Folder in the bucket, under {STORAGE_PREFIX}/. */
  folder: string;
  /** Roles that may upload for this purpose. */
  roles: readonly RoleId[];
  /** Also needed, if set: the user must hold this permission (checks Sub-Admin areas too). */
  capability?: Capability;
  /** File types allowed for this purpose. */
  contentTypes: readonly AllowedContentType[];
  /** Words for messages, e.g. "a PDF or an image (JPG, PNG, WebP, HEIC)". */
  typesLabel: string;
  maxBytes: number;
};

/** Each purpose: its folder, who may upload, which types, how big. */
export const UPLOAD_PURPOSES = {
  /** PAN / Aadhaar photos and the GST certificate: the partner (self sign-up) or field staff. */
  kyc: {
    folder: "kyc",
    roles: [ROLE.PARTNER, ROLE.ASM, ROLE.SALES_EXECUTIVE],
    contentTypes: [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
    ],
    typesLabel: "a PDF or an image (JPG, PNG, WebP, HEIC)",
    maxBytes: 10 * MB,
  },
  /** The one image of a product (DEC-110, DEC-113): Admin and the Products & Catalog Sub-Admin. */
  product_image: {
    folder: "products",
    roles: [ROLE.ADMIN, ROLE.SUB_ADMIN],
    capability: "products.manage",
    contentTypes: ["image/jpeg", "image/png", "image/webp"],
    typesLabel: "a JPG, PNG or WebP image",
    maxBytes: 5 * MB,
  },
  /**
   * Proof of a payout payment, optional, any method (Module 10 T4, DEC-151, DEC-155): staff
   * who can mark payouts paid. Only staff ever see it.
   */
  payout_proof: {
    folder: "payouts",
    roles: [ROLE.ADMIN, ROLE.SUB_ADMIN, ROLE.ZONAL_HEAD],
    capability: "payouts.mark_paid",
    contentTypes: [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
    ],
    typesLabel: "a PDF or an image (JPG, PNG, WebP, HEIC)",
    maxBytes: 5 * MB,
  },
  /**
   * Receipt for money received or refunded on a request, optional, added only at that step
   * (Module 11 T4, DEC-164, DEC-170): the handler side (ASM, Sales Executive). Same file rules
   * as payout proof. The partner app does not show it (DEC-169).
   */
  request_receipt: {
    folder: "requests",
    roles: [ROLE.ASM, ROLE.SALES_EXECUTIVE],
    capability: "requests.handle",
    contentTypes: [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
    ],
    typesLabel: "a PDF or an image (JPG, PNG, WebP, HEIC)",
    maxBytes: 5 * MB,
  },
  /**
   * Completion photos of a field task, 1 – 10 per task (Module 12 T3, DEC-177, DEC-181): the
   * person the task was given to. Images only; camera or gallery both fine (app side).
   */
  task_photo: {
    folder: "tasks",
    roles: [ROLE.SUB_ADMIN, ROLE.ZONAL_HEAD, ROLE.ASM, ROLE.SALES_EXECUTIVE],
    capability: "tasks.complete",
    contentTypes: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
    typesLabel: "an image (JPG, PNG, WebP, HEIC)",
    maxBytes: 5 * MB,
  },
} as const satisfies Record<string, UploadRule>;

export type UploadPurpose = keyof typeof UPLOAD_PURPOSES;

/** The rule for a purpose, typed loosely so callers can read optional fields. */
export function uploadRule(purpose: UploadPurpose): UploadRule {
  return UPLOAD_PURPOSES[purpose];
}

/** "10 MB", "5 MB" — for messages. */
export function sizeLabel(bytes: number): string {
  return `${Math.round(bytes / MB)} MB`;
}

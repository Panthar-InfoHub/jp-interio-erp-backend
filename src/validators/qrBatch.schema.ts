import { z } from "zod";
import { listQuery } from "../utils/pagination.js";
import { idParams } from "./common.js";

/** Routes like /api/qr/batches/:id/export */
export const qrBatchIdSchemas = { params: idParams };

/**
 * QR batches (Module 7).
 * The upper limits for quantity and points are settings the Admin can change
 * (`qr.max_batch_size`, `qr.max_points_per_code`, DEC-119), so the service checks
 * them; here we only check the shape.
 */

/** POST /api/qr/batches */
export const createQrBatchSchemas = {
  body: z.object({
    productId: z.uuid("Invalid product id"),
    quantity: z.int("Quantity must be a whole number").min(1, "Quantity must be at least 1"),
    pointsPerCode: z
      .int("Points per code must be a whole number")
      .min(1, "Points per code must be at least 1"),
    /** Optional (DEC-120). An empty string means "no notes". */
    notes: z
      .string()
      .trim()
      .max(500)
      .transform((value) => (value === "" ? null : value))
      .optional(),
  }),
};

/** POST /api/qr/batches/:id/void — permanent; a reason is required (DEC-124). */
export const voidQrBatchSchemas = {
  params: idParams,
  body: z.object({
    reason: z
      .string("Reason is required")
      .trim()
      .min(10, "Reason must be at least 10 characters")
      .max(500, "Reason can be at most 500 characters")
      .transform((value) => value.replace(/\s+/g, " ")),
  }),
};

/** A moment like "2026-11-19T00:00:00+05:30"; the screen sends its own day start / end. */
const moment = (label: string) =>
  z.iso
    .datetime({
      offset: true,
      message: `${label} must be a date-time like 2026-11-19T00:00:00+05:30`,
    })
    .transform((value) => new Date(value));

/** GET /api/qr/batches — newest first by default (DEC-125). */
export const listQrBatchesSchemas = {
  query: listQuery({
    sortFields: ["createdAt", "batchNo", "quantity"],
    defaultSort: "-createdAt",
  })
    .extend({
      status: z.enum(["generated", "exported", "voided"]).optional(),
      productId: z.uuid("Invalid product id").optional(),
      /** Made at or after this moment. */
      createdFrom: moment("createdFrom").optional(),
      /** Made at or before this moment. */
      createdTo: moment("createdTo").optional(),
      /** Part of the batch number, any case, e.g. "2026-00". */
      search: z.string().trim().min(1).max(30).optional(),
    })
    .refine(
      (query) => !query.createdFrom || !query.createdTo || query.createdFrom <= query.createdTo,
      { message: "createdFrom must be before createdTo", path: ["createdTo"] }
    ),
};

/** GET /api/qr/batches/:id/codes — in the same order as the download (DEC-125). */
export const listBatchCodesSchemas = {
  params: idParams,
  query: listQuery({
    sortFields: ["createdAt", "code", "scannedAt"],
    defaultSort: "createdAt",
  }).extend({
    status: z.enum(["active", "scanned", "void"]).optional(),
    /** Part of the code, any case, spaces ignored. */
    search: z
      .string()
      .trim()
      .min(1)
      .max(30)
      .transform((value) => value.replace(/\s/g, "").toUpperCase())
      .optional(),
  }),
};

/**
 * GET /api/qr/codes/:code — the plain code or the full link (DEC-125). A link must be
 * URL-encoded in the path (encodeURIComponent).
 */
export const lookupQrCodeSchemas = {
  params: z.object({ code: z.string().trim().min(1, "Code is required").max(300) }),
};

/** GET /api/qr/products — the batch screen's product picker (DEC-122). */
export const listQrProductsSchemas = {
  query: listQuery({ sortFields: ["name", "sku", "createdAt"], defaultSort: "name" }).extend({
    brandId: z.uuid("Invalid brand id").optional(),
    /** Includes every category below it (DEC-109). */
    categoryId: z.uuid("Invalid category id").optional(),
    /** Matches SKU or name (any part, any case; spaces ignored for SKU). */
    search: z.string().trim().min(1).max(100).optional(),
  }),
};

export type CreateQrBatchInput = z.output<typeof createQrBatchSchemas.body>;
export type ListQrBatchesQuery = z.output<typeof listQrBatchesSchemas.query>;
export type ListBatchCodesQuery = z.output<typeof listBatchCodesSchemas.query>;
export type VoidQrBatchInput = z.output<typeof voidQrBatchSchemas.body>;
export type ListQrProductsQuery = z.output<typeof listQrProductsSchemas.query>;

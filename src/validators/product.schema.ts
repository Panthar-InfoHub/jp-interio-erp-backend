import { z } from "zod";
import { listQuery } from "../utils/pagination.js";
import { idParams } from "./common.js";

/** Product fields (Module 6 T5, DEC-108 – DEC-114). */

/** Extra spaces inside are squeezed. */
const text = (max: number, label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max)
    .transform((value) => value.replace(/\s+/g, " "));

/** Optional free text (thickness, size, grade); an empty string is saved as "not set". */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === "" ? null : value.replace(/\s+/g, " ")));

/**
 * Rupees, more than 0, at most 2 decimals, up to 99,99,99,99,999.99 (Decimal(12,2)).
 * Accepts 1250, 1250.5 or "1250.50"; passed on as text so no rounding ever happens.
 */
const mrp = z
  .union([z.number(), z.string().trim()], "MRP must be a number")
  .transform((value, ctx) => {
    const textValue = typeof value === "number" ? String(value) : value;
    if (!/^\d{1,10}(\.\d{1,2})?$/.test(textValue)) {
      ctx.addIssue({
        code: "custom",
        message: "MRP must be an amount in rupees with at most 2 decimals, e.g. 1250 or 1250.50",
      });
      return z.NEVER;
    }
    if (Number(textValue) <= 0) {
      ctx.addIssue({ code: "custom", message: "MRP must be more than 0" });
      return z.NEVER;
    }
    return textValue;
  });

/** The `fileUrl` from an upload link with purpose `product_image` (T4, DEC-113). */
const imageUrl = z.url("Image must be the fileUrl from the upload link").max(1000);

const fields = {
  sku: text(50, "SKU"),
  name: text(200, "Name"),
  brandId: z.uuid("Invalid brand id"),
  categoryId: z.uuid("Invalid category id"),
  thickness: optionalText(50),
  size: optionalText(100),
  grade: optionalText(50),
  mrp,
  imageUrl,
};

/** POST /api/products — SKU, name, brand, category, MRP and image are required (DEC-110). */
export const createProductSchemas = {
  body: z.object({
    ...fields,
    thickness: fields.thickness.optional(),
    size: fields.size.optional(),
    grade: fields.grade.optional(),
  }),
};

/**
 * PATCH /api/products/:id — send only what changes.
 * `null` (or "") clears thickness / size / grade. The image can be replaced, never removed.
 */
export const updateProductSchemas = {
  params: idParams,
  body: z
    .object({
      sku: fields.sku.optional(),
      name: fields.name.optional(),
      brandId: fields.brandId.optional(),
      categoryId: fields.categoryId.optional(),
      thickness: fields.thickness.nullable().optional(),
      size: fields.size.nullable().optional(),
      grade: fields.grade.nullable().optional(),
      mrp: fields.mrp.optional(),
      imageUrl: fields.imageUrl.optional(),
    })
    .refine((body) => Object.keys(body).length > 0, "Send at least one field to change"),
};

/** GET /api/products */
export const listProductsSchemas = {
  query: listQuery({ sortFields: ["name", "sku", "mrp", "createdAt"], defaultSort: "name" }).extend(
    {
      brandId: z.uuid("Invalid brand id").optional(),
      /** Includes every category below it (DEC-109). */
      categoryId: z.uuid("Invalid category id").optional(),
      /** "Contains", any case (free text, DEC-108). */
      thickness: z.string().trim().min(1).max(50).optional(),
      grade: z.string().trim().min(1).max(50).optional(),
      /** The product's own switch. */
      status: z.enum(["active", "inactive"]).optional(),
      /** Matches SKU or name (any part, any case). */
      search: z.string().trim().min(1).max(100).optional(),
    }
  ),
};

/** GET /api/products/:id, POST /api/products/:id/deactivate, POST …/reactivate */
export const productIdSchemas = { params: idParams };

export type CreateProductInput = z.output<typeof createProductSchemas.body>;
export type UpdateProductInput = z.output<typeof updateProductSchemas.body>;
export type ListProductsQuery = z.output<typeof listProductsSchemas.query>;

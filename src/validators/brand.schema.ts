import { z } from "zod";
import { listQuery } from "../utils/pagination.js";
import { idParams } from "./common.js";

/** Brand fields (Module 6 T2, DEC-108, DEC-111). */

/** Extra spaces inside are squeezed: "Green   Ply" → "Green Ply". */
const name = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(100)
  .transform((value) => value.replace(/\s+/g, " "));

/**
 * Optional. Saved in CAPITALS: "gp-01" → "GP-01". Letters, digits and hyphens only.
 * An empty string means "no code".
 */
const code = z
  .string()
  .trim()
  .toUpperCase()
  .max(20)
  .regex(/^[A-Z0-9-]*$/, "Code can only have letters, digits and hyphens")
  .transform((value) => (value === "" ? null : value));

/** POST /api/brands */
export const createBrandSchemas = {
  body: z.object({
    name,
    code: code.optional(),
  }),
};

/** PATCH /api/brands/:id — send only what changes; `code: null` (or "") removes the code. */
export const updateBrandSchemas = {
  params: idParams,
  body: z
    .object({
      name: name.optional(),
      code: code.nullable().optional(),
    })
    .refine((body) => Object.keys(body).length > 0, "Send at least one field to change"),
};

/** GET /api/brands */
export const listBrandsSchemas = {
  query: listQuery({ sortFields: ["name", "code", "createdAt"], defaultSort: "name" }).extend({
    status: z.enum(["active", "inactive"]).optional(),
    /** Matches name or code (any part, any case). */
    search: z.string().trim().min(1).max(100).optional(),
  }),
};

/** GET /api/brands/:id, POST /api/brands/:id/deactivate, POST /api/brands/:id/reactivate */
export const brandIdSchemas = { params: idParams };

export type CreateBrandInput = z.output<typeof createBrandSchemas.body>;
export type UpdateBrandInput = z.output<typeof updateBrandSchemas.body>;
export type ListBrandsQuery = z.output<typeof listBrandsSchemas.query>;

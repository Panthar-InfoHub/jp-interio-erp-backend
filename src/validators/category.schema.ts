import { z } from "zod";
import { idParams } from "./common.js";

/** Product category fields (Module 6 T3, DEC-108 – DEC-112). */

/** Extra spaces inside are squeezed: "Marine   Ply" → "Marine Ply". */
const name = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(100)
  .transform((value) => value.replace(/\s+/g, " "));

const parentId = z.uuid("Invalid parent category id");

/** POST /api/categories — no `parentId` (or null) = a top-level category. */
export const createCategorySchemas = {
  body: z.object({
    name,
    parentId: parentId.nullable().optional(),
  }),
};

/**
 * PATCH /api/categories/:id — send only what changes.
 * `parentId`: another category's id = move under it; `null` = move to the top level.
 */
export const updateCategorySchemas = {
  params: idParams,
  body: z
    .object({
      name: name.optional(),
      parentId: parentId.nullable().optional(),
    })
    .refine((body) => Object.keys(body).length > 0, "Send at least one field to change"),
};

/** GET /api/categories/:id, POST /api/categories/:id/deactivate, POST …/reactivate */
export const categoryIdSchemas = { params: idParams };

export type CreateCategoryInput = z.output<typeof createCategorySchemas.body>;
export type UpdateCategoryInput = z.output<typeof updateCategorySchemas.body>;

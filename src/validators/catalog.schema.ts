import { z } from "zod";
import { listQuery } from "../utils/pagination.js";
import { idParams } from "./common.js";

/** App catalog (Module 6 T6, DEC-111, DEC-115): brand, category and text search only. */

/** GET /api/catalog/products */
export const catalogProductsSchemas = {
  query: listQuery({ sortFields: ["name", "mrp"], defaultSort: "name" }).extend({
    brandId: z.uuid("Invalid brand id").optional(),
    /** Includes every category below it (DEC-109). */
    categoryId: z.uuid("Invalid category id").optional(),
    /** Matches SKU or name (any part, any case; spaces ignored for the SKU). */
    search: z.string().trim().min(1).max(100).optional(),
  }),
};

/** GET /api/catalog/products/:id */
export const catalogProductIdSchemas = { params: idParams };

export type CatalogProductsQuery = z.output<typeof catalogProductsSchemas.query>;

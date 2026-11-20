import type { ValidatedRequest } from "../middlewares/validate.js";
import * as catalogService from "../services/catalog.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import type {
  catalogProductIdSchemas,
  catalogProductsSchemas,
} from "../validators/catalog.schema.js";

/** GET /api/catalog/products — every role; partners must be verified. */
export const products = asyncHandler<ValidatedRequest<typeof catalogProductsSchemas>>(
  async (req, res) => {
    const { items, meta } = await catalogService.listCatalogProducts(req.query);
    sendSuccess(res, 200, items, undefined, meta);
  }
);

/** GET /api/catalog/products/:id */
export const product = asyncHandler<ValidatedRequest<typeof catalogProductIdSchemas>>(
  async (req, res) => {
    sendSuccess(res, 200, await catalogService.getCatalogProduct(req.params.id));
  }
);

/** GET /api/catalog/categories */
export const categories = asyncHandler(async (_req, res) => {
  sendSuccess(res, 200, await catalogService.getCatalogCategories());
});

/** GET /api/catalog/brands */
export const brands = asyncHandler(async (_req, res) => {
  sendSuccess(res, 200, await catalogService.getCatalogBrands());
});

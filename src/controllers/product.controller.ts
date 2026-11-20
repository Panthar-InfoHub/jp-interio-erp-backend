import { getAuthUser } from "../middlewares/auth.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import * as productService from "../services/product.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import type {
  createProductSchemas,
  listProductsSchemas,
  productIdSchemas,
  updateProductSchemas,
} from "../validators/product.schema.js";

/** GET /api/products — Admin, Products & Catalog Sub-Admin. */
export const list = asyncHandler<ValidatedRequest<typeof listProductsSchemas>>(async (req, res) => {
  const { items, meta } = await productService.listProducts(req.query);
  sendSuccess(res, 200, items, undefined, meta);
});

/** GET /api/products/:id */
export const get = asyncHandler<ValidatedRequest<typeof productIdSchemas>>(async (req, res) => {
  sendSuccess(res, 200, await productService.getProduct(req.params.id));
});

/** POST /api/products */
export const create = asyncHandler<ValidatedRequest<typeof createProductSchemas>>(
  async (req, res) => {
    const product = await productService.createProduct(getAuthUser(req), req.body);
    sendSuccess(res, 201, product, "Product created");
  }
);

/** PATCH /api/products/:id */
export const update = asyncHandler<ValidatedRequest<typeof updateProductSchemas>>(
  async (req, res) => {
    const { product, changed } = await productService.updateProduct(
      getAuthUser(req),
      req.params.id,
      req.body
    );
    sendSuccess(res, 200, product, changed ? "Product updated" : "No change");
  }
);

/** POST /api/products/:id/deactivate */
export const deactivate = asyncHandler<ValidatedRequest<typeof productIdSchemas>>(
  async (req, res) => {
    const { product, changed } = await productService.deactivateProduct(
      getAuthUser(req),
      req.params.id
    );
    sendSuccess(res, 200, product, changed ? "Product deactivated" : "Product is already inactive");
  }
);

/** POST /api/products/:id/reactivate */
export const reactivate = asyncHandler<ValidatedRequest<typeof productIdSchemas>>(
  async (req, res) => {
    const { product, changed } = await productService.reactivateProduct(
      getAuthUser(req),
      req.params.id
    );
    sendSuccess(res, 200, product, changed ? "Product reactivated" : "Product is already active");
  }
);

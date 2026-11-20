import { getAuthUser } from "../middlewares/auth.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import * as brandService from "../services/brand.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import type {
  brandIdSchemas,
  createBrandSchemas,
  listBrandsSchemas,
  updateBrandSchemas,
} from "../validators/brand.schema.js";

/** GET /api/brands — Admin, Products & Catalog Sub-Admin. */
export const list = asyncHandler<ValidatedRequest<typeof listBrandsSchemas>>(async (req, res) => {
  const { items, meta } = await brandService.listBrands(req.query);
  sendSuccess(res, 200, items, undefined, meta);
});

/** GET /api/brands/:id */
export const get = asyncHandler<ValidatedRequest<typeof brandIdSchemas>>(async (req, res) => {
  sendSuccess(res, 200, await brandService.getBrand(req.params.id));
});

/** POST /api/brands */
export const create = asyncHandler<ValidatedRequest<typeof createBrandSchemas>>(
  async (req, res) => {
    sendSuccess(
      res,
      201,
      await brandService.createBrand(getAuthUser(req), req.body),
      "Brand created"
    );
  }
);

/** PATCH /api/brands/:id */
export const update = asyncHandler<ValidatedRequest<typeof updateBrandSchemas>>(
  async (req, res) => {
    const { brand, changed } = await brandService.updateBrand(
      getAuthUser(req),
      req.params.id,
      req.body
    );
    sendSuccess(res, 200, brand, changed ? "Brand updated" : "No change");
  }
);

/** POST /api/brands/:id/deactivate */
export const deactivate = asyncHandler<ValidatedRequest<typeof brandIdSchemas>>(
  async (req, res) => {
    const { brand, changed } = await brandService.deactivateBrand(getAuthUser(req), req.params.id);
    sendSuccess(res, 200, brand, changed ? "Brand deactivated" : "Brand is already inactive");
  }
);

/** POST /api/brands/:id/reactivate */
export const reactivate = asyncHandler<ValidatedRequest<typeof brandIdSchemas>>(
  async (req, res) => {
    const { brand, changed } = await brandService.reactivateBrand(getAuthUser(req), req.params.id);
    sendSuccess(res, 200, brand, changed ? "Brand reactivated" : "Brand is already active");
  }
);

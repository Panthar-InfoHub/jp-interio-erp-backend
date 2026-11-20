import { getAuthUser } from "../middlewares/auth.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import * as categoryService from "../services/category.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import type {
  categoryIdSchemas,
  createCategorySchemas,
  updateCategorySchemas,
} from "../validators/category.schema.js";

/** "Plywood" / "Plywood" and "Doors" — for messages. */
function quoteNames(names: string[]): string {
  return names.map((name) => `"${name}"`).join(" and ");
}

/** GET /api/categories/tree — Admin, Products & Catalog Sub-Admin. */
export const tree = asyncHandler(async (_req, res) => {
  sendSuccess(res, 200, await categoryService.getCategoryTree());
});

/** GET /api/categories/:id */
export const get = asyncHandler<ValidatedRequest<typeof categoryIdSchemas>>(async (req, res) => {
  sendSuccess(res, 200, await categoryService.getCategory(req.params.id));
});

/** POST /api/categories */
export const create = asyncHandler<ValidatedRequest<typeof createCategorySchemas>>(
  async (req, res) => {
    const category = await categoryService.createCategory(getAuthUser(req), req.body);
    sendSuccess(res, 201, category, "Category created");
  }
);

/** PATCH /api/categories/:id — rename and/or move. */
export const update = asyncHandler<ValidatedRequest<typeof updateCategorySchemas>>(
  async (req, res) => {
    const { category, changed } = await categoryService.updateCategory(
      getAuthUser(req),
      req.params.id,
      req.body
    );
    sendSuccess(res, 200, category, changed ? "Category updated" : "No change");
  }
);

/** POST /api/categories/:id/deactivate */
export const deactivate = asyncHandler<ValidatedRequest<typeof categoryIdSchemas>>(
  async (req, res) => {
    const { category, changed, subCategoriesAffected } = await categoryService.deactivateCategory(
      getAuthUser(req),
      req.params.id
    );
    const message = !changed
      ? "Category is already inactive"
      : subCategoriesAffected > 0
        ? `Category deactivated. ${subCategoriesAffected} sub-categor${subCategoriesAffected === 1 ? "y below it is" : "ies below it are"} now off too.`
        : "Category deactivated";
    sendSuccess(res, 200, category, message);
  }
);

/** POST /api/categories/:id/reactivate */
export const reactivate = asyncHandler<ValidatedRequest<typeof categoryIdSchemas>>(
  async (req, res) => {
    const { category, changed, stillOffBecauseOf } = await categoryService.reactivateCategory(
      getAuthUser(req),
      req.params.id
    );
    const stillOff =
      stillOffBecauseOf.length > 0
        ? ` It stays off until ${quoteNames(stillOffBecauseOf)} above it ${stillOffBecauseOf.length === 1 ? "is" : "are"} switched on.`
        : "";
    const message = (changed ? "Category reactivated." : "Category is already active.") + stillOff;
    sendSuccess(res, 200, category, message);
  }
);

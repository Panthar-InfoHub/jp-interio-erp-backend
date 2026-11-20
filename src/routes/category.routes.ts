import { Router } from "express";
import * as categoryController from "../controllers/category.controller.js";
import { requireAuth } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import {
  categoryIdSchemas,
  createCategorySchemas,
  updateCategorySchemas,
} from "../validators/category.schema.js";

/**
 * Product categories, web console side (Module 6 T3). Every route needs `products.manage`:
 * the Admin and the Products & Catalog Sub-Admin (DEC-108). Everyone else gets 403.
 * The apps' "switched-on categories" tree is part of the catalog routes (T6).
 */
const router = Router();

router.use(requireAuth, requirePermission("products.manage"));

// `/tree` before `/:id`, so "tree" is not read as an id.
router.get("/tree", categoryController.tree);
router.get("/:id", validate(categoryIdSchemas), categoryController.get);
router.post("/", validate(createCategorySchemas), categoryController.create);
router.patch("/:id", validate(updateCategorySchemas), categoryController.update);
router.post("/:id/deactivate", validate(categoryIdSchemas), categoryController.deactivate);
router.post("/:id/reactivate", validate(categoryIdSchemas), categoryController.reactivate);

export default router;

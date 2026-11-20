import { Router } from "express";
import * as brandController from "../controllers/brand.controller.js";
import { requireAuth } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import {
  brandIdSchemas,
  createBrandSchemas,
  listBrandsSchemas,
  updateBrandSchemas,
} from "../validators/brand.schema.js";

/**
 * Brands, web console side (Module 6 T2). Every route needs `products.manage`:
 * the Admin and the Products & Catalog Sub-Admin (DEC-108). Everyone else gets 403.
 * The apps' short "switched-on brands" list is part of the catalog routes (T6).
 */
const router = Router();

router.use(requireAuth, requirePermission("products.manage"));

router.get("/", validate(listBrandsSchemas), brandController.list);
router.get("/:id", validate(brandIdSchemas), brandController.get);
router.post("/", validate(createBrandSchemas), brandController.create);
router.patch("/:id", validate(updateBrandSchemas), brandController.update);
router.post("/:id/deactivate", validate(brandIdSchemas), brandController.deactivate);
router.post("/:id/reactivate", validate(brandIdSchemas), brandController.reactivate);

export default router;

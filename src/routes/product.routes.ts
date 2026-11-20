import { Router } from "express";
import * as productController from "../controllers/product.controller.js";
import { requireAuth } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import {
  createProductSchemas,
  listProductsSchemas,
  productIdSchemas,
  updateProductSchemas,
} from "../validators/product.schema.js";

/**
 * Products, web console side (Module 6 T5). Every route needs `products.manage`:
 * the Admin and the Products & Catalog Sub-Admin (DEC-108, DEC-114). Everyone else gets 403
 * and uses the app catalog (`/api/catalog`, T6).
 */
const router = Router();

router.use(requireAuth, requirePermission("products.manage"));

router.get("/", validate(listProductsSchemas), productController.list);
router.get("/:id", validate(productIdSchemas), productController.get);
router.post("/", validate(createProductSchemas), productController.create);
router.patch("/:id", validate(updateProductSchemas), productController.update);
router.post("/:id/deactivate", validate(productIdSchemas), productController.deactivate);
router.post("/:id/reactivate", validate(productIdSchemas), productController.reactivate);

export default router;

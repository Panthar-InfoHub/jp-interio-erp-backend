import { Router } from "express";
import * as catalogController from "../controllers/catalog.controller.js";
import { requireAuth } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import { requireVerifiedIfPartner } from "../middlewares/verifiedPartner.js";
import { catalogProductIdSchemas, catalogProductsSchemas } from "../validators/catalog.schema.js";

/**
 * The app catalog (Module 6 T6, DEC-115). Read-only.
 * - Every role holds `catalog.view` (DEC-044 Q11).
 * - A partner must also be verified, else 403 PARTNER_NOT_VERIFIED (DEC-104); staff pass.
 */
const router = Router();

router.use(requireAuth, requireVerifiedIfPartner, requirePermission("catalog.view"));

router.get("/products", validate(catalogProductsSchemas), catalogController.products);
router.get("/products/:id", validate(catalogProductIdSchemas), catalogController.product);
router.get("/categories", catalogController.categories);
router.get("/brands", catalogController.brands);

export default router;

import { Router } from "express";
import * as subAdminController from "../controllers/subAdmin.controller.js";
import { requireAuth } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import { idParams } from "../validators/common.js";
import { setAreasSchemas } from "../validators/subAdmin.schema.js";

/** Sub-Admin areas (DEC-053). Admin only, through the `sub_admins.manage` action. */
const router = Router();

router.use(requireAuth, requirePermission("sub_admins.manage"));

router.get("/", subAdminController.list);
router.get("/:id/areas", validate({ params: idParams }), subAdminController.getAreas);
router.put("/:id/areas", validate(setAreasSchemas), subAdminController.setAreas);

export default router;

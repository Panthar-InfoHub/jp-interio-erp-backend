import { Router } from "express";
import * as settingsController from "../controllers/settings.controller.js";
import { requireAuth } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import { updateSettingSchemas } from "../validators/settings.schema.js";

/** System settings (DEC-054). Admin only, through the `settings.manage` action. */
const router = Router();

router.use(requireAuth, requirePermission("settings.manage"));

router.get("/", settingsController.list);
router.patch("/:key", validate(updateSettingSchemas), settingsController.update);

export default router;

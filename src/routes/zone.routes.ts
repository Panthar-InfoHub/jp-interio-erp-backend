import { Router } from "express";
import { ROLE } from "../config/roles.js";
import * as zoneController from "../controllers/zone.controller.js";
import { requireAuth, requireRole } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import {
  createZoneSchemas,
  listZonesSchemas,
  setZonalHeadSchemas,
  updateZoneSchemas,
  zoneIdSchemas,
} from "../validators/zone.schema.js";

/**
 * Zones (DEC-060). Every staff user can view; partners get 403.
 * Changes are Admin only, through the `zones.manage` action.
 */
const router = Router();

router.use(
  requireAuth,
  requireRole(ROLE.ADMIN, ROLE.SUB_ADMIN, ROLE.ZONAL_HEAD, ROLE.ASM, ROLE.SALES_EXECUTIVE)
);

const manage = requirePermission("zones.manage");

router.get("/", validate(listZonesSchemas), zoneController.list);
router.get("/:id", validate(zoneIdSchemas), zoneController.get);
router.post("/", manage, validate(createZoneSchemas), zoneController.create);
router.patch("/:id", manage, validate(updateZoneSchemas), zoneController.update);
router.post("/:id/deactivate", manage, validate(zoneIdSchemas), zoneController.deactivate);
router.post("/:id/reactivate", manage, validate(zoneIdSchemas), zoneController.reactivate);
router.post("/:id/zonal-head", manage, validate(setZonalHeadSchemas), zoneController.setZonalHead);

export default router;

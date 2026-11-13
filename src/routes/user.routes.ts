import { Router } from "express";
import * as userController from "../controllers/user.controller.js";
import { ROLE } from "../config/roles.js";
import { requireAuth, requireRole } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import {
  createUserSchemas,
  listUsersSchemas,
  pickerSchemas,
  transferUserSchemas,
  updateMeSchemas,
  updateUserSchemas,
  userIdSchemas,
} from "../validators/user.schema.js";

const STAFF_ROLES = [
  ROLE.ADMIN,
  ROLE.SUB_ADMIN,
  ROLE.ZONAL_HEAD,
  ROLE.ASM,
  ROLE.SALES_EXECUTIVE,
] as const;

/**
 * Staff users (Module 4).
 * - POST /: the permission depends on the role being added (sub_admins.manage /
 *   users.create / sales_exec.create), so the service checks it (DEC-062).
 * - GET /, GET /:id: `users.view`, scoped (DEC-063).
 * - GET /picker: `users.pick` (Admin; Tasks / Leads & Requests Sub-Admins).
 * - PATCH /me: any staff user, own name and email (DEC-064).
 * - PATCH /:id: `users.edit` (Admin; Zonal Head in their zone), name, phone, email.
 */
const router = Router();

router.use(requireAuth);

router.post("/", validate(createUserSchemas), userController.create);
router.get("/", requirePermission("users.view"), validate(listUsersSchemas), userController.list);
// Before "/:id", so "picker" is not read as an id.
router.get(
  "/picker",
  requirePermission("users.pick"),
  validate(pickerSchemas),
  userController.picker
);
router.get("/:id", requirePermission("users.view"), validate(userIdSchemas), userController.get);

// "My profile": any staff user, own name and email only. Before "/:id".
router.patch(
  "/me",
  requireRole(...STAFF_ROLES),
  validate(updateMeSchemas),
  userController.updateMe
);
router.patch(
  "/:id",
  requirePermission("users.edit"),
  validate(updateUserSchemas),
  userController.update
);

// Switch off / on (DEC-065). The permission depends on the person's role
// (users.deactivate / sales_exec.deactivate / sub_admins.manage): the service checks it.
router.post("/:id/deactivate", validate(userIdSchemas), userController.deactivate);
router.post("/:id/reactivate", validate(userIdSchemas), userController.reactivate);

// Move a Sales Executive or an ASM (DEC-066). Permission by role, checked in the service.
router.post("/:id/transfer", validate(transferUserSchemas), userController.transfer);

export default router;

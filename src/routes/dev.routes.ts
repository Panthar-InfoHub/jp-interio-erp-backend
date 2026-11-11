import { Router, type RequestHandler } from "express";
import { isCapability, type Capability } from "../config/capabilities.js";
import { canCreateSchemas } from "../validators/dev.schema.js";
import * as devController from "../controllers/dev.controller.js";
import { requireAuth } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import { idParams } from "../validators/common.js";
import { NotFoundError } from "../utils/errors.js";

/**
 * Development-only tools. Mounted in routes/index.ts only when NODE_ENV is not
 * "production" (DEC-050).
 */
const router = Router();

/** Runs the real `requirePermission` guard for the action named in the URL. */
const guardFromParam: RequestHandler = (req, res, next) => {
  const capability = req.params.capability;
  if (typeof capability !== "string" || !isCapability(capability)) {
    throw new NotFoundError(`Unknown action "${String(capability)}"`);
  }
  return requirePermission(capability)(req, res, next);
};

router.get(
  "/permission-check/:capability",
  requireAuth,
  guardFromParam,
  devController.permissionCheck
);

// The scope filter at work (DEC-051): who can I see?
router.get(
  "/scope/partners",
  requireAuth,
  requirePermission("partners.view"),
  devController.scopePartners
);
router.get(
  "/scope/partners/:id",
  requireAuth,
  requirePermission("partners.view"),
  validate({ params: idParams }),
  devController.scopePartner
);
router.get("/scope/staff", requireAuth, requirePermission("users.view"), devController.scopeStaff);
router.get(
  "/scope/staff/:id",
  requireAuth,
  requirePermission("users.view"),
  validate({ params: idParams }),
  devController.scopeStaffMember
);

// The "only below me" rule (DEC-052). The guard here only checks that you may see the
// records; what is being tested is the rule itself.
router.get(
  "/can-manage/staff/:id",
  requireAuth,
  requirePermission("users.view"),
  validate({ params: idParams }),
  devController.canManageStaff
);
router.get(
  "/can-manage/partners/:id",
  requireAuth,
  requirePermission("partners.view"),
  validate({ params: idParams }),
  devController.canManagePartner
);

/** The action that adds each role (DEC-044), so the real guard runs before the rule. */
const CREATE_ACTION: Record<string, Capability> = {
  admin: "sub_admins.manage",
  sub_admin: "sub_admins.manage",
  zonal_head: "users.create",
  asm: "users.create",
  sales_executive: "sales_exec.create",
  partner: "partners.onboard",
};
const guardForNewRole: RequestHandler = (req, res, next) => {
  const capability = CREATE_ACTION[(req.body as { role: string }).role];
  if (!capability) throw new NotFoundError("Unknown role");
  return requirePermission(capability)(req, res, next);
};
router.post(
  "/can-create",
  requireAuth,
  validate(canCreateSchemas),
  guardForNewRole,
  devController.canCreate
);

export default router;

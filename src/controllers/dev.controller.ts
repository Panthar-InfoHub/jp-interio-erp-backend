import { getAuthUser } from "../middlewares/auth.js";
import { getScope } from "../middlewares/permission.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import { ROLES } from "../config/roles.js";
import * as devService from "../services/dev.service.js";
import { assertCanCreate, assertCanManage } from "../services/hierarchy.service.js";
import type { idParams } from "../validators/common.js";
import type { canCreateSchemas } from "../validators/dev.schema.js";
import { ValidationError } from "../utils/errors.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// Development only; not mounted in production (DEC-050, DEC-051).

/** GET /api/dev/permission-check/:capability — reached only if the real guard allowed it. */
export const permissionCheck = asyncHandler(async (req, res) => {
  const user = getAuthUser(req);
  sendSuccess(
    res,
    200,
    { capability: req.params.capability, allowed: true, scope: getScope(req), role: user.roleKey },
    "Allowed"
  );
});

/** GET /api/dev/scope/partners — the partners I can see. */
export const scopePartners = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, await devService.listVisiblePartners(getAuthUser(req), getScope(req)));
});

/** GET /api/dev/scope/partners/:id — one partner, or 404 if outside my scope. */
export const scopePartner = asyncHandler<ValidatedRequest<{ params: typeof idParams }>>(
  async (req, res) => {
    sendSuccess(
      res,
      200,
      await devService.getVisiblePartner(getAuthUser(req), getScope(req), req.params.id)
    );
  }
);

/** GET /api/dev/can-manage/staff/:id — may I manage this staff member? (DEC-052) */
export const canManageStaff = asyncHandler<ValidatedRequest<{ params: typeof idParams }>>(
  async (req, res) => {
    const target = await assertCanManage(getAuthUser(req), getScope(req), "staff", req.params.id);
    sendSuccess(res, 200, { allowed: true, target }, "You can manage this staff member");
  }
);

/** GET /api/dev/can-manage/partners/:id — may I manage this partner? (DEC-052) */
export const canManagePartner = asyncHandler<ValidatedRequest<{ params: typeof idParams }>>(
  async (req, res) => {
    const target = await assertCanManage(getAuthUser(req), getScope(req), "partner", req.params.id);
    sendSuccess(res, 200, { allowed: true, target }, "You can manage this partner");
  }
);

/** POST /api/dev/can-create — { role, zoneId? }: could I add this person? (DEC-052) */
export const canCreate = asyncHandler<ValidatedRequest<typeof canCreateSchemas>>(
  async (req, res) => {
    const role = ROLES.find((r) => r.key === req.body.role);
    if (!role) throw new ValidationError("Unknown role");
    const zoneId = req.body.zoneId ?? null;
    assertCanCreate(getAuthUser(req), getScope(req), { roleId: role.id, zoneId });
    sendSuccess(res, 200, { allowed: true, role: role.key, zoneId }, "You can add this person");
  }
);

/** GET /api/dev/scope/staff — the staff I can see. */
export const scopeStaff = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, await devService.listVisibleStaff(getAuthUser(req), getScope(req)));
});

/** GET /api/dev/scope/staff/:id — one staff member, or 404 if outside my scope. */
export const scopeStaffMember = asyncHandler<ValidatedRequest<{ params: typeof idParams }>>(
  async (req, res) => {
    sendSuccess(
      res,
      200,
      await devService.getVisibleStaff(getAuthUser(req), getScope(req), req.params.id)
    );
  }
);

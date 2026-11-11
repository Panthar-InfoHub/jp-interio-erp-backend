import { ROLES, type RoleId } from "../config/roles.js";
import type { PermissionScope } from "../generated/prisma/enums.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { ForbiddenError } from "../utils/errors.js";
import { assertInScope, scopeForPartners, scopeForStaff } from "./scope.service.js";

/**
 * The "only below me" rule (DEC-052). Use it together with the permission guard:
 * the guard says IF you may do the action (and gives the scope); this says WHO you
 * may do it to.
 *
 * - You may only manage someone whose role is strictly BELOW yours (higher tier number)
 *   and who is inside your scope. Never yourself.
 * - Same level or above → 403. Outside your scope (or not existing) → 404.
 */

const tierOf = (roleId: number): number => {
  const role = ROLES.find((r) => r.id === roleId);
  // An unknown role is treated as the top tier, so nobody can manage it.
  return role ? role.tier : -1;
};

/** True if `roleId` is strictly below my role (Admin = 0 … Partner = 5). */
export function isBelowMe(me: Pick<AuthUser, "roleId">, roleId: number): boolean {
  return tierOf(roleId) > tierOf(me.roleId);
}

export type ManagedKind = "staff" | "partner";

function refuse(me: AuthUser, reason: string, extra: Record<string, unknown>): never {
  logger.warn({ userId: me.id, role: me.roleKey, reason, ...extra }, "Hierarchy rule refused");
  throw new ForbiddenError();
}

/**
 * Checks that I may manage this staff member or partner, and returns them.
 *
 *   const target = await assertCanManage(me, getScope(req), "staff", req.params.id);
 *
 * The target is loaded with the scope filter of its kind, so a staff route can never
 * reach a partner and the other way round.
 */
export async function assertCanManage(
  me: AuthUser,
  scope: PermissionScope,
  kind: ManagedKind,
  targetId: string
) {
  const scopeFilter = kind === "staff" ? scopeForStaff(me, scope) : scopeForPartners(me, scope);
  const target = await prisma.user.findFirst({
    where: { AND: [{ id: targetId }, scopeFilter] },
    select: {
      id: true,
      name: true,
      phone: true,
      roleId: true,
      zoneId: true,
      parentId: true,
      status: true,
    },
  });
  const found = assertInScope(target, {
    user: me,
    entity: kind === "staff" ? "staff member" : "partner",
    id: targetId,
  });

  if (found.id === me.id) {
    refuse(me, "self", { targetId });
  }
  if (!isBelowMe(me, found.roleId)) {
    refuse(me, "not_below", { targetId, targetRoleId: found.roleId });
  }
  return found;
}

/**
 * Checks that I may add a new person with this role in this zone.
 * - The new role must be strictly below mine.
 * - "full" scope (Admin, Sub-Admin with the area): any zone.
 * - "scoped" / "own" (Zonal Head, ASM, Sales Executive): only my own zone.
 * Which manager the new person sits under is checked by Modules 4–5.
 */
export function assertCanCreate(
  me: AuthUser,
  scope: PermissionScope,
  newPerson: { roleId: RoleId; zoneId: string | null }
): void {
  if (!isBelowMe(me, newPerson.roleId)) {
    refuse(me, "not_below", { newRoleId: newPerson.roleId });
  }
  if (scope === "full") return;
  if (!me.zoneId || newPerson.zoneId !== me.zoneId) {
    refuse(me, "outside_zone", { newRoleId: newPerson.roleId, zoneId: newPerson.zoneId });
  }
}

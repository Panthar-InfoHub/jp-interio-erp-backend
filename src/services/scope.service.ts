import { ROLE } from "../config/roles.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { PermissionScope } from "../generated/prisma/enums.js";
import { logger } from "../lib/logger.js";
import type { AuthUser } from "../middlewares/auth.js";
import { NotFoundError } from "../utils/errors.js";

/**
 * The scope filter: WHICH records a user may see or touch (DEC-051).
 *
 * The permission guard (`requirePermission`) decides IF the user may do an action and
 * gives its scope ("full", "scoped" or "own", read with `getScope(req)`). The functions
 * here turn that scope into a Prisma `where` filter for one kind of record:
 *
 *   const where = { AND: [scopeForPartners(user, getScope(req)), filtersFromTheQuery] };
 *
 * Rules:
 * - Every list and every get-by-ID goes through one of these filters (rule R2).
 * - When in doubt, match nothing (a missing zone, a role with no meaning for "own").
 * - Later modules add their own function here (scopeForTasks, scopeForLeads, …).
 */

/** The parts of the logged-in user the filters need. */
export type ScopeUser = Pick<AuthUser, "id" | "roleId" | "zoneId">;

/** A filter that matches no record. */
const NOTHING = { id: { in: [] } } satisfies Prisma.UserWhereInput;

/**
 * Partners this user may see (DEC-051). Partners are rows in `users` with the Partner role.
 * - full:   all partners (Admin, Sub-Admin).
 * - scoped: partners in the user's zone (Zonal Head).
 * - own:    ASM → partners they own (an SE always works under the owning ASM, so this
 *           already covers the SEs' partners); Sales Executive → partners currently
 *           assigned to them; Partner → only themselves.
 */
export function scopeForPartners(user: ScopeUser, scope: PermissionScope): Prisma.UserWhereInput {
  const partners: Prisma.UserWhereInput = { roleId: ROLE.PARTNER };

  switch (scope) {
    case "full":
      return partners;
    case "scoped":
      return user.zoneId ? { ...partners, zoneId: user.zoneId } : NOTHING;
    case "own":
      switch (user.roleId) {
        case ROLE.ASM:
          return { ...partners, parentId: user.id };
        case ROLE.SALES_EXECUTIVE:
          return { ...partners, partnerProfile: { is: { salesExecutiveId: user.id } } };
        case ROLE.PARTNER:
          return { ...partners, id: user.id };
        default:
          return NOTHING;
      }
  }
}

/**
 * Staff this user may see (DEC-051): never partners, always including the user themselves.
 * - full:   all staff (Admin; Sub-Admin through the staff picker).
 * - scoped: everyone in the user's zone: the Zonal Head, its ASMs and SEs.
 * - own:    ASM → themselves and their own Sales Executives.
 *           Others (SE, Partner) have no staff list → nothing.
 */
export function scopeForStaff(user: ScopeUser, scope: PermissionScope): Prisma.UserWhereInput {
  const staff: Prisma.UserWhereInput = { roleId: { not: ROLE.PARTNER } };

  switch (scope) {
    case "full":
      return staff;
    case "scoped":
      return user.zoneId ? { ...staff, zoneId: user.zoneId } : NOTHING;
    case "own":
      if (user.roleId === ROLE.ASM) {
        return { ...staff, OR: [{ id: user.id }, { parentId: user.id }] };
      }
      return NOTHING;
  }
}

/**
 * Requests this user may VIEW (Module 11, `requests.view`; DEC-164, DEC-173).
 * - full:   all requests (Admin, Requests Sub-Admin).
 * - scoped: requests of partners now in the user's zone (Zonal Head; the partner's current
 *           zone, like payouts).
 * - own:    ASM → requests handled by them or their Sales Executives, plus every request
 *           of partners they own now (DEC-173 option B); Sales Executive → only requests
 *           they handle now; Partner → their own.
 * Moving stages uses `handlerWhere` in request.service.ts instead (handler side only).
 */
export function scopeForRequests(
  user: ScopeUser,
  scope: PermissionScope
): Prisma.PartnerRequestWhereInput {
  const none: Prisma.PartnerRequestWhereInput = { id: { in: [] } };
  switch (scope) {
    case "full":
      return {};
    case "scoped":
      return user.zoneId ? { partner: { zoneId: user.zoneId } } : none;
    case "own":
      switch (user.roleId) {
        case ROLE.ASM:
          return {
            OR: [
              { handlerId: user.id },
              { handler: { parentId: user.id, roleId: ROLE.SALES_EXECUTIVE } },
              { partner: { parentId: user.id, roleId: ROLE.PARTNER } },
            ],
          };
        case ROLE.SALES_EXECUTIVE:
          return { handlerId: user.id };
        case ROLE.PARTNER:
          return { partnerId: user.id };
        default:
          return none;
      }
  }
}

/**
 * For get-by-ID endpoints. Load the record WITH the scope filter, then pass it here:
 *
 *   const partner = await prisma.user.findFirst({
 *     where: { AND: [{ id }, scopeForPartners(user, scope)] },
 *   });
 *   assertInScope(partner, { user, entity: "partner", id });
 *
 * A record that does not exist and a record outside the user's scope look the same:
 * both are 404 Not Found, so nobody can learn that a record exists (rule R2).
 * The refusal is logged as a warning for security review.
 */
export function assertInScope<T>(
  record: T | null | undefined,
  context: { user: Pick<AuthUser, "id" | "roleKey">; entity: string; id: string }
): T {
  if (record) return record;
  logger.warn(
    {
      userId: context.user.id,
      role: context.user.roleKey,
      entity: context.entity,
      entityId: context.id,
    },
    "Record not found or outside scope"
  );
  const label = context.entity.charAt(0).toUpperCase() + context.entity.slice(1);
  throw new NotFoundError(`${label} not found`);
}

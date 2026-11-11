import {
  CAPABILITIES,
  CAPABILITY_KEYS,
  isCapability,
  type Capability,
} from "../config/capabilities.js";
import { ROLE } from "../config/roles.js";
import type { PermissionScope, SubAdminArea } from "../generated/prisma/enums.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";

/**
 * Answers "may this user do this action, and on whose records?" (DEC-050).
 *
 * - The `permissions` table (filled by the seed) is kept in memory and read again
 *   every 60 seconds, so a seed change applies within a minute, without a restart.
 * - No row = refused (default deny).
 * - Sub-Admins also need an area that unlocks the action (`capabilities.ts`). Their areas
 *   come from `req.user`, which `requireAuth` loads fresh on every request.
 */

const CACHE_TTL_MS = 60_000;

/** roleId → (action → scope) */
type Matrix = Map<number, Map<Capability, PermissionScope>>;

let cached: { matrix: Matrix; loadedAt: number } | undefined;
/** The load in progress, shared so many requests at once make only one database call. */
let loading: Promise<Matrix> | undefined;

async function loadMatrix(): Promise<Matrix> {
  const rows = await prisma.permission.findMany({
    select: { roleId: true, capability: true, scope: true },
  });

  const matrix: Matrix = new Map();
  for (const row of rows) {
    // A row left over from an old action name: ignore it (the next seed deletes it).
    if (!isCapability(row.capability)) {
      logger.warn(
        { capability: row.capability },
        "Unknown action in the permissions table, ignored"
      );
      continue;
    }
    let forRole = matrix.get(row.roleId);
    if (!forRole) {
      forRole = new Map();
      matrix.set(row.roleId, forRole);
    }
    forRole.set(row.capability, row.scope);
  }
  return matrix;
}

async function getMatrix(): Promise<Matrix> {
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.matrix;

  loading ??= loadMatrix()
    .then((matrix) => {
      cached = { matrix, loadedAt: Date.now() };
      return matrix;
    })
    .finally(() => {
      loading = undefined;
    });
  return loading;
}

/** Forget the cached matrix; the next check reads the table again. */
export function clearPermissionCache(): void {
  cached = undefined;
}

/** True if one of the Sub-Admin's areas unlocks this action (DEC-019, DEC-048). */
function subAdminAreaAllows(areas: readonly SubAdminArea[], capability: Capability): boolean {
  const rule: readonly SubAdminArea[] | "every_area" | "never" = CAPABILITIES[capability].subAdmin;
  if (rule === "never") return false;
  if (rule === "every_area") return true;
  return rule.some((area) => areas.includes(area));
}

type PermissionUser = Pick<AuthUser, "roleId" | "subAdminAreas">;

/** The scope this user has for the action, or `null` if they may not do it. */
export async function getPermissionScope(
  user: PermissionUser,
  capability: Capability
): Promise<PermissionScope | null> {
  const matrix = await getMatrix();
  const scope = matrix.get(user.roleId)?.get(capability);
  if (!scope) return null;
  if (user.roleId === ROLE.SUB_ADMIN && !subAdminAreaAllows(user.subAdminAreas, capability)) {
    return null;
  }
  return scope;
}

/**
 * Every action this user may do, with its scope, in the order of `capabilities.ts`.
 * For GET /api/auth/me/permissions (the apps use it to show or hide buttons).
 */
export async function listMyPermissions(
  user: PermissionUser
): Promise<Partial<Record<Capability, PermissionScope>>> {
  const matrix = await getMatrix();
  const forRole = matrix.get(user.roleId);
  const result: Partial<Record<Capability, PermissionScope>> = {};
  if (!forRole) return result;

  for (const capability of CAPABILITY_KEYS) {
    const scope = forRole.get(capability);
    if (!scope) continue;
    if (user.roleId === ROLE.SUB_ADMIN && !subAdminAreaAllows(user.subAdminAreas, capability)) {
      continue;
    }
    result[capability] = scope;
  }
  return result;
}

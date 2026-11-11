import { ROLE } from "../config/roles.js";
import { SubAdminArea } from "../generated/prisma/enums.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { NotFoundError } from "../utils/errors.js";
import { recordAudit } from "./audit.service.js";

/**
 * Sub-Admin areas, managed by the Admin (DEC-053). The areas decide which actions a
 * Sub-Admin may do (capabilities.ts). `requireAuth` reads them fresh on every request,
 * so a change applies on the Sub-Admin's next request.
 */

/** Areas in a fixed order (the order of the enum), so lists always look the same. */
const AREA_ORDER = Object.values(SubAdminArea);
const sortAreas = (areas: SubAdminArea[]) =>
  [...areas].sort((a, b) => AREA_ORDER.indexOf(a) - AREA_ORDER.indexOf(b));

/** GET /sub-admins — every Sub-Admin with their areas. */
export async function listSubAdmins() {
  const subAdmins = await prisma.user.findMany({
    where: { roleId: ROLE.SUB_ADMIN },
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      status: true,
      createdAt: true,
      subAdminAreas: { select: { area: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return subAdmins.map(({ subAdminAreas, ...subAdmin }) => ({
    ...subAdmin,
    areas: sortAreas(subAdminAreas.map((grant) => grant.area)),
  }));
}

/** The Sub-Admin with this id, or 404 (also when the id belongs to someone else). */
async function findSubAdmin(id: string) {
  const subAdmin = await prisma.user.findFirst({
    where: { id, roleId: ROLE.SUB_ADMIN },
    select: { id: true, name: true, phone: true, status: true },
  });
  if (!subAdmin) throw new NotFoundError("Sub-Admin not found");
  return subAdmin;
}

/** GET /sub-admins/:id/areas — one Sub-Admin's areas, with who gave each and when. */
export async function getAreas(id: string) {
  const subAdmin = await findSubAdmin(id);
  const grants = await prisma.subAdminAreaGrant.findMany({
    where: { userId: id },
    select: {
      area: true,
      grantedAt: true,
      grantedBy: { select: { id: true, name: true } },
    },
  });
  grants.sort((a, b) => AREA_ORDER.indexOf(a.area) - AREA_ORDER.indexOf(b.area));
  return { ...subAdmin, areas: grants };
}

/**
 * PUT /sub-admins/:id/areas — make the Sub-Admin's areas exactly `areas` (DEC-053).
 * Adds the new ones, removes the missing ones, and writes one audit row with the
 * before/after lists, all in one transaction. The same list again changes nothing.
 */
export async function setAreas(admin: AuthUser, id: string, areas: SubAdminArea[]) {
  await findSubAdmin(id);

  const changed = await prisma.$transaction(async (tx) => {
    const current = await tx.subAdminAreaGrant.findMany({
      where: { userId: id },
      select: { area: true },
    });
    const before = sortAreas(current.map((grant) => grant.area));
    const after = sortAreas(areas);

    const added = after.filter((area) => !before.includes(area));
    const removed = before.filter((area) => !after.includes(area));
    if (added.length === 0 && removed.length === 0) return false;

    if (removed.length > 0) {
      await tx.subAdminAreaGrant.deleteMany({ where: { userId: id, area: { in: removed } } });
    }
    if (added.length > 0) {
      await tx.subAdminAreaGrant.createMany({
        data: added.map((area) => ({ userId: id, area, grantedById: admin.id })),
      });
    }

    await recordAudit(tx, {
      actorId: admin.id,
      action: "sub_admin.areas_update",
      entity: { type: "user", id },
      before: { areas: before },
      after: { areas: after, added, removed },
    });
    return true;
  });

  return { ...(await getAreas(id)), changed };
}

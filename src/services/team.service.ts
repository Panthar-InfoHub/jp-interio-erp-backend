import { ROLE } from "../config/roles.js";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";

/**
 * ASM "My Team" (Module 4, Task 8; DEC-068).
 * - The ASM's Sales Executives who are active or suspended (switched-off ones are hidden).
 * - Partner counts include suspended partners; deactivated partners are left out.
 * TODO(Modules 11–13): add open leads, tasks and requests per Sales Executive.
 */

const NOT_DEACTIVATED = { status: { not: "deactivated" } } satisfies Prisma.UserWhereInput;

/** GET /team */
export async function getMyTeam(asm: AuthUser) {
  const myPartners = {
    parentId: asm.id,
    roleId: ROLE.PARTNER,
    ...NOT_DEACTIVATED,
  } satisfies Prisma.UserWhereInput;

  const [salesExecutives, totalPartners, assigned] = await Promise.all([
    prisma.user.findMany({
      where: { parentId: asm.id, roleId: ROLE.SALES_EXECUTIVE, ...NOT_DEACTIVATED },
      select: { id: true, name: true, phone: true, email: true, status: true, createdAt: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
    prisma.user.count({ where: myPartners }),
    prisma.partnerProfile.groupBy({
      by: ["salesExecutiveId"],
      where: { salesExecutiveId: { not: null }, user: myPartners },
      _count: { _all: true },
    }),
  ]);

  const partnersOf = (salesExecutiveId: string) =>
    assigned.find((row) => row.salesExecutiveId === salesExecutiveId)?._count._all ?? 0;
  const assignedTotal = assigned.reduce((sum, row) => sum + row._count._all, 0);

  return {
    summary: {
      salesExecutives: salesExecutives.length,
      partners: totalPartners,
      unassignedPartners: totalPartners - assignedTotal,
    },
    salesExecutives: salesExecutives.map((se) => ({
      ...se,
      counts: { partners: partnersOf(se.id) },
    })),
  };
}

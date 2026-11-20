import { ROLE } from "../config/roles.js";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { handlerWhere, OPEN_REQUEST_WHERE } from "./request.service.js";
import { taskCountsFor } from "./task.service.js";

/**
 * ASM "My Team" (Module 4, Task 8; DEC-068).
 * - The ASM's Sales Executives who are active or suspended (switched-off ones are hidden).
 * - Partner counts include suspended partners; deactivated partners are left out.
 * - Open requests (Module 11 T5, DEC-172): per Sales Executive (the ones they handle) and a
 *   team total (the ASM's own plus their Sales Executives').
 * - Tasks (Module 12 T6, DEC-184): pending and overdue tasks given to each Sales Executive,
 *   and a team total (the ASM's own plus their Sales Executives').
 */

const NOT_DEACTIVATED = { status: { not: "deactivated" } } satisfies Prisma.UserWhereInput;

/** GET /team */
export async function getMyTeam(asm: AuthUser) {
  const myPartners = {
    parentId: asm.id,
    roleId: ROLE.PARTNER,
    ...NOT_DEACTIVATED,
  } satisfies Prisma.UserWhereInput;

  const [salesExecutives, totalPartners, assigned, openByHandler, openTotal] = await Promise.all([
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
    // Open requests each of my Sales Executives handles (Module 11 T5, DEC-172).
    prisma.partnerRequest.groupBy({
      by: ["handlerId"],
      where: {
        AND: [{ handler: { parentId: asm.id, roleId: ROLE.SALES_EXECUTIVE } }, OPEN_REQUEST_WHERE],
      },
      _count: { _all: true },
    }),
    // The whole team's open requests: mine plus my Sales Executives'.
    prisma.partnerRequest.count({ where: { AND: [handlerWhere(asm), OPEN_REQUEST_WHERE] } }),
  ]);

  // Tasks given to me and to each of my Sales Executives (DEC-184).
  const tasks = await taskCountsFor([asm.id, ...salesExecutives.map((se) => se.id)]);
  const tasksOf = (id: string) => tasks.get(id) ?? { pending: 0, overdue: 0, givenOpen: 0 };

  const partnersOf = (salesExecutiveId: string) =>
    assigned.find((row) => row.salesExecutiveId === salesExecutiveId)?._count._all ?? 0;
  const openRequestsOf = (salesExecutiveId: string) =>
    openByHandler.find((row) => row.handlerId === salesExecutiveId)?._count._all ?? 0;
  const assignedTotal = assigned.reduce((sum, row) => sum + row._count._all, 0);
  const teamTasks = [...tasks.values()];

  return {
    summary: {
      salesExecutives: salesExecutives.length,
      partners: totalPartners,
      unassignedPartners: totalPartners - assignedTotal,
      openRequests: openTotal,
      pendingTasks: teamTasks.reduce((sum, counts) => sum + counts.pending, 0),
      overdueTasks: teamTasks.reduce((sum, counts) => sum + counts.overdue, 0),
    },
    salesExecutives: salesExecutives.map((se) => ({
      ...se,
      counts: {
        partners: partnersOf(se.id),
        openRequests: openRequestsOf(se.id),
        pendingTasks: tasksOf(se.id).pending,
        overdueTasks: tasksOf(se.id).overdue,
      },
    })),
  };
}

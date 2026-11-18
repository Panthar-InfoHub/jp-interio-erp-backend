import { ROLES } from "../config/roles.js";
import { prisma } from "../lib/prisma.js";
import { getOnboarding } from "./onboarding.service.js";

/**
 * Everything about one partner, shared by the KYC detail (T8) and Partner 360 (T13).
 * NO scope check here: callers check scope first (rule R2).
 * Full numbers and photo links (DEC-083: everyone allowed to see the partner sees them).
 */

export const roleName = (roleId: number | null | undefined) =>
  ROLES.find((role) => role.id === roleId)?.name ?? null;

const person = { select: { id: true, name: true, phone: true } } as const;

export async function buildPartnerDetail(partnerId: string) {
  const [details, people, history] = await Promise.all([
    getOnboarding(partnerId),
    prisma.partnerProfile.findUniqueOrThrow({
      where: { userId: partnerId },
      select: {
        createdAt: true,
        reviewedAt: true,
        user: { select: { status: true, parent: person } },
        salesExecutive: person,
        onboardedBy: { select: { id: true, name: true, phone: true, roleId: true } },
      },
    }),
    prisma.kycReview.findMany({
      where: { partnerId },
      select: {
        id: true,
        action: true,
        reason: true,
        createdAt: true,
        actor: { select: { id: true, name: true, roleId: true } },
        assignedAsm: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return {
    partnerId,
    accountStatus: people.user.status,
    joinedAt: people.createdAt,
    reviewedAt: people.reviewedAt,
    asm: people.user.parent,
    salesExecutive: people.salesExecutive,
    /** The ASM / Sales Executive who started the onboarding. null = self sign-up. */
    startedBy: people.onboardedBy
      ? {
          id: people.onboardedBy.id,
          name: people.onboardedBy.name,
          phone: people.onboardedBy.phone,
          role: roleName(people.onboardedBy.roleId),
        }
      : null,
    ...details,
    /** Submitted, approved, rejected, rejection undone: oldest first, never changed. */
    history: history.map((entry) => ({
      id: entry.id,
      action: entry.action,
      reason: entry.reason,
      at: entry.createdAt,
      by: { id: entry.actor.id, name: entry.actor.name, role: roleName(entry.actor.roleId) },
      assignedAsm: entry.assignedAsm,
    })),
  };
}

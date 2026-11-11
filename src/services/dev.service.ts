import type { PermissionScope } from "../generated/prisma/enums.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { assertInScope, scopeForPartners, scopeForStaff } from "./scope.service.js";

/**
 * Development-only helpers to see the scope filter at work (DEC-051).
 * Used by /api/dev/scope/* only; never mounted in production.
 * Real partner and staff endpoints come in Modules 4 and 5.
 */

/** A short, readable view of a user, to check who is visible. */
const userView = {
  id: true,
  name: true,
  phone: true,
  status: true,
  role: { select: { key: true } },
  zone: { select: { id: true, code: true } },
  parent: { select: { name: true, phone: true } },
} as const;

const partnerView = {
  ...userView,
  partnerProfile: {
    select: {
      kycState: true,
      salesExecutive: { select: { name: true, phone: true } },
    },
  },
} as const;

export async function listVisiblePartners(user: AuthUser, scope: PermissionScope) {
  const partners = await prisma.user.findMany({
    where: scopeForPartners(user, scope),
    select: partnerView,
    orderBy: { phone: "asc" },
  });
  return { scope, count: partners.length, partners };
}

export async function getVisiblePartner(user: AuthUser, scope: PermissionScope, id: string) {
  const partner = await prisma.user.findFirst({
    where: { AND: [{ id }, scopeForPartners(user, scope)] },
    select: partnerView,
  });
  return assertInScope(partner, { user, entity: "partner", id });
}

export async function listVisibleStaff(user: AuthUser, scope: PermissionScope) {
  const staff = await prisma.user.findMany({
    where: scopeForStaff(user, scope),
    select: userView,
    orderBy: [{ roleId: "asc" }, { phone: "asc" }],
  });
  return { scope, count: staff.length, staff };
}

export async function getVisibleStaff(user: AuthUser, scope: PermissionScope, id: string) {
  const member = await prisma.user.findFirst({
    where: { AND: [{ id }, scopeForStaff(user, scope)] },
    select: userView,
  });
  return assertInScope(member, { user, entity: "staff member", id });
}

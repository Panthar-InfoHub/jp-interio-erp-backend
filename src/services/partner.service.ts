import { ROLE } from "../config/roles.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { PermissionScope } from "../generated/prisma/enums.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { ConflictError } from "../utils/errors.js";
import { pageMeta, toPrismaOrderBy, toPrismaPaging } from "../utils/pagination.js";
import type { ListPartnersQuery } from "../validators/partner.schema.js";
import { recordAudit } from "./audit.service.js";
import { buildPartnerDetail } from "./partnerDetail.service.js";
import { assertInScope, scopeForPartners, scopeForStaff } from "./scope.service.js";

/**
 * Partners: who looks after them (Module 4, Task 9; DEC-069). Module 5 adds onboarding,
 * KYC and the partner list here.
 * - Assign / unassign a Sales Executive: the owning ASM only.
 * - Move to another ASM: Zonal Head (own zone) or Admin (any zone). Clears the SE.
 * - Active and suspended partners only. The partner is not logged out.
 */

// ---- Partner list and Partner 360 (Module 5 T13; DEC-083, DEC-093, DEC-105) ----

/**
 * GET /partners — VERIFIED partners only (DEC-105), within `partners.view` scope:
 * SE assigned, ASM own, ZH zone, Partners & KYC Sub-Admin and Admin all.
 * Pending / rejected partners live in the KYC queue; unfinished ones in "my drafts".
 */
export async function listPartners(me: AuthUser, scope: PermissionScope, query: ListPartnersQuery) {
  const where: Prisma.UserWhereInput = {
    AND: [
      scopeForPartners(me, scope),
      { partnerProfile: { is: { kycState: "verified", draftRemovedAt: null } } },
      {
        ...(query.zoneId && { zoneId: query.zoneId }),
        ...(query.asmId && { parentId: query.asmId }),
        ...(query.status && { status: query.status }),
      },
      ...(query.partnerType
        ? [{ partnerProfile: { is: { partnerType: query.partnerType } } }]
        : []),
      ...(query.salesExecutiveId
        ? [{ partnerProfile: { is: { salesExecutiveId: query.salesExecutiveId } } }]
        : []),
      ...(query.search
        ? [
            {
              OR: [
                { name: { contains: query.search, mode: "insensitive" as const } },
                { phone: { contains: query.search } },
                {
                  partnerProfile: {
                    is: { businessName: { contains: query.search, mode: "insensitive" as const } },
                  },
                },
              ],
            },
          ]
        : []),
    ],
  };

  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        phone: true,
        status: true,
        createdAt: true,
        zone: { select: { id: true, name: true, code: true } },
        parent: { select: { id: true, name: true } },
        partnerProfile: {
          select: {
            partnerType: true,
            businessName: true,
            kycState: true,
            reviewedAt: true,
            salesExecutive: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: toPrismaOrderBy(query.sort),
      ...toPrismaPaging(query.page, query.limit),
    }),
    prisma.user.count({ where }),
  ]);

  const items = rows.map((row) => ({
    id: row.id,
    name: row.name,
    phone: row.phone,
    status: row.status,
    partnerType: row.partnerProfile?.partnerType ?? null,
    businessName: row.partnerProfile?.businessName ?? null,
    kycState: row.partnerProfile?.kycState ?? null,
    zone: row.zone,
    asm: row.parent,
    salesExecutive: row.partnerProfile?.salesExecutive ?? null,
    joinedAt: row.createdAt,
    verifiedAt: row.partnerProfile?.reviewedAt ?? null,
  }));

  return { items, meta: pageMeta(query.page, query.limit, total) };
}

/**
 * GET /partners/:id — Partner 360: ANY state (unfinished, pending, verified, rejected),
 * within `partners.view` scope (DEC-105). Retired drafts → 404 (DEC-093).
 * Later modules add wallet, scans, payouts and requests to this reply.
 */
export async function getPartner360(me: AuthUser, scope: PermissionScope, id: string) {
  assertInScope(
    await prisma.user.findFirst({
      where: {
        AND: [
          { id },
          scopeForPartners(me, scope),
          { partnerProfile: { is: { draftRemovedAt: null } } },
        ],
      },
      select: { id: true },
    }),
    { user: me, entity: "partner", id }
  );
  return buildPartnerDetail(id);
}

/** What a partner looks like in these replies. */
const PARTNER_FIELDS = {
  id: true,
  name: true,
  phone: true,
  status: true,
  zone: { select: { id: true, name: true, code: true } },
  parent: { select: { id: true, name: true } },
  partnerProfile: {
    select: {
      businessName: true,
      salesExecutive: { select: { id: true, name: true } },
    },
  },
} as const;

async function partnerView(id: string) {
  const { parent, partnerProfile, ...partner } = await prisma.user.findUniqueOrThrow({
    where: { id },
    select: PARTNER_FIELDS,
  });
  return {
    ...partner,
    businessName: partnerProfile?.businessName ?? null,
    asm: parent,
    salesExecutive: partnerProfile?.salesExecutive ?? null,
  };
}

/** A partner I may act on (scope filter; outside → 404), not deactivated. */
async function loadPartner(me: AuthUser, scope: PermissionScope, id: string) {
  const partner = assertInScope(
    await prisma.user.findFirst({
      where: { AND: [{ id }, scopeForPartners(me, scope)] },
      select: {
        id: true,
        parentId: true,
        zoneId: true,
        status: true,
        partnerProfile: { select: { salesExecutiveId: true } },
      },
    }),
    { user: me, entity: "partner", id }
  );
  if (partner.status === "deactivated") {
    throw new ConflictError("This partner is deactivated.");
  }
  return { ...partner, salesExecutiveId: partner.partnerProfile?.salesExecutiveId ?? null };
}

/**
 * POST /partners/:id/assign-sales-executive (ASM). The SE must be active and report to
 * the partner's ASM. Switching straight from one SE to another is allowed.
 */
export async function assignSalesExecutive(
  me: AuthUser,
  scope: PermissionScope,
  partnerId: string,
  salesExecutiveId: string
) {
  const partner = await loadPartner(me, scope, partnerId);

  // Only a Sales Executive of the partner's own ASM; anyone else looks "not found".
  const salesExecutive = assertInScope(
    partner.parentId
      ? await prisma.user.findFirst({
          where: {
            id: salesExecutiveId,
            roleId: ROLE.SALES_EXECUTIVE,
            parentId: partner.parentId,
          },
          select: { id: true, status: true },
        })
      : null,
    { user: me, entity: "Sales Executive", id: salesExecutiveId }
  );
  if (salesExecutive.status !== "active") {
    throw new ConflictError("This Sales Executive is not active. Choose an active one.");
  }
  if (partner.salesExecutiveId === salesExecutiveId) {
    return { changed: false, partner: await partnerView(partnerId) };
  }

  await prisma.$transaction(async (tx) => {
    await tx.partnerProfile.upsert({
      where: { userId: partnerId },
      create: { userId: partnerId, salesExecutiveId },
      update: { salesExecutiveId },
    });
    await recordAudit(tx, {
      actorId: me.id,
      action: "partner.assign_sales_executive",
      entity: { type: "user", id: partnerId },
      before: { salesExecutiveId: partner.salesExecutiveId },
      after: { salesExecutiveId },
    });
  });

  return { changed: true, partner: await partnerView(partnerId) };
}

/** POST /partners/:id/unassign-sales-executive (ASM). No SE already → no change. */
export async function unassignSalesExecutive(
  me: AuthUser,
  scope: PermissionScope,
  partnerId: string
) {
  const partner = await loadPartner(me, scope, partnerId);
  if (partner.salesExecutiveId === null) {
    return { changed: false, partner: await partnerView(partnerId) };
  }

  await prisma.$transaction(async (tx) => {
    await tx.partnerProfile.update({
      where: { userId: partnerId },
      data: { salesExecutiveId: null },
    });
    await recordAudit(tx, {
      actorId: me.id,
      action: "partner.unassign_sales_executive",
      entity: { type: "user", id: partnerId },
      before: { salesExecutiveId: partner.salesExecutiveId },
      after: { salesExecutiveId: null },
    });
  });

  return { changed: true, partner: await partnerView(partnerId) };
}

/**
 * POST /partners/:id/transfer (Zonal Head own zone, Admin any zone). The partner gets the
 * new ASM and the ASM's zone, and loses their Sales Executive. Old records are untouched.
 */
export async function transferPartner(
  me: AuthUser,
  scope: PermissionScope,
  partnerId: string,
  asmId: string
) {
  const partner = await loadPartner(me, scope, partnerId);
  if (partner.parentId === asmId) {
    throw new ConflictError("This partner already belongs to that ASM.");
  }

  await prisma.$transaction(async (tx) => {
    // A Zonal Head only finds ASMs in their zone, so moves across zones are Admin only.
    const asm = assertInScope(
      await tx.user.findFirst({
        where: { AND: [{ id: asmId, roleId: ROLE.ASM }, scopeForStaff(me, scope)] },
        select: { id: true, status: true, zoneId: true },
      }),
      { user: me, entity: "ASM", id: asmId }
    );
    if (asm.status !== "active") {
      throw new ConflictError("The new ASM is not active. Choose an active ASM.");
    }
    if (!asm.zoneId) throw new Error(`ASM ${asm.id} has no zone`);
    const zone = await tx.zone.findUniqueOrThrow({
      where: { id: asm.zoneId },
      select: { name: true, status: true },
    });
    if (zone.status !== "active") {
      throw new ConflictError(`Zone "${zone.name}" is inactive.`);
    }

    await tx.user.update({
      where: { id: partnerId },
      data: { parentId: asm.id, zoneId: asm.zoneId },
    });
    await tx.partnerProfile.upsert({
      where: { userId: partnerId },
      create: { userId: partnerId },
      update: { salesExecutiveId: null },
    });
    await recordAudit(tx, {
      actorId: me.id,
      action: "partner.transfer",
      entity: { type: "user", id: partnerId },
      before: {
        parentId: partner.parentId,
        zoneId: partner.zoneId,
        salesExecutiveId: partner.salesExecutiveId,
      },
      after: { parentId: asm.id, zoneId: asm.zoneId, salesExecutiveId: null },
    });
  });

  return { partner: await partnerView(partnerId), salesExecutiveCleared: partner.salesExecutiveId };
}

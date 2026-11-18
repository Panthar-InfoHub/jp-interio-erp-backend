import { ROLE } from "../config/roles.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { PermissionScope } from "../generated/prisma/enums.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { AppError, ValidationError } from "../utils/errors.js";
import { pageMeta, toPrismaOrderBy, toPrismaPaging } from "../utils/pagination.js";
import type { KycQueueQuery } from "../validators/kyc.schema.js";
import { recordAudit } from "./audit.service.js";
import { buildPartnerDetail, roleName } from "./partnerDetail.service.js";
import { assertInScope, scopeForPartners } from "./scope.service.js";

/**
 * KYC queue (Module 5 T8; DEC-073, DEC-074, DEC-083, DEC-098).
 *
 * Who checks (`kyc.verify`): the Zonal Head of the partner's zone ("scoped"), the
 * Partners & KYC Sub-Admin and the Admin ("full"). ASMs and Sales Executives never.
 *
 *   pending ──approve──▶ verified      (self sign-up: the checker picks an ASM of that zone)
 *      │
 *      └──reject (reason)──▶ rejected ──undo (Admin, reason)──▶ pending (back in the queue)
 *
 * Reject is final for the partner: no re-submission (DEC-073). Only the Admin can undo it.
 * Every step writes a `kyc_reviews` row (insert-only history) and an audit row, in one
 * transaction. Each step is guarded on the current state, so two checkers acting at the
 * same moment cannot both succeed.
 */

/** Partners this checker may see, minus unfinished and retired drafts. */
function queueWhere(actor: AuthUser, scope: PermissionScope): Prisma.PartnerProfileWhereInput {
  return {
    user: { is: scopeForPartners(actor, scope) },
    kycState: { not: "not_submitted" },
    draftRemovedAt: null,
  };
}

// ---- Queue list ----

export async function listQueue(actor: AuthUser, scope: PermissionScope, query: KycQueueQuery) {
  const where: Prisma.PartnerProfileWhereInput = {
    AND: [
      queueWhere(actor, scope),
      {
        kycState: query.state,
        ...(query.partnerType && { partnerType: query.partnerType }),
        ...(query.zoneId && { user: { is: { zoneId: query.zoneId } } }),
      },
      ...(query.search
        ? [
            {
              OR: [
                { businessName: { contains: query.search, mode: "insensitive" as const } },
                {
                  user: { is: { name: { contains: query.search, mode: "insensitive" as const } } },
                },
                { user: { is: { phone: { contains: query.search } } } },
              ],
            },
          ]
        : []),
    ],
  };

  const [rows, total] = await Promise.all([
    prisma.partnerProfile.findMany({
      where,
      select: {
        userId: true,
        partnerType: true,
        businessName: true,
        kycState: true,
        submittedAt: true,
        reviewedAt: true,
        rejectionReason: true,
        user: {
          select: {
            name: true,
            phone: true,
            status: true,
            zone: { select: { id: true, name: true, code: true } },
            parent: { select: { id: true, name: true } },
          },
        },
        salesExecutive: { select: { id: true, name: true } },
        onboardedBy: { select: { id: true, name: true, roleId: true } },
      },
      orderBy: toPrismaOrderBy(query.sort, "userId"),
      ...toPrismaPaging(query.page, query.limit),
    }),
    prisma.partnerProfile.count({ where }),
  ]);

  const items = rows.map((row) => ({
    partnerId: row.userId,
    name: row.user.name,
    phone: row.user.phone,
    accountStatus: row.user.status,
    partnerType: row.partnerType,
    businessName: row.businessName,
    zone: row.user.zone,
    kycState: row.kycState,
    submittedAt: row.submittedAt,
    reviewedAt: row.reviewedAt,
    rejectionReason: row.rejectionReason,
    asm: row.user.parent,
    salesExecutive: row.salesExecutive,
    /** null = the partner signed up on their own. */
    startedBy: row.onboardedBy
      ? {
          id: row.onboardedBy.id,
          name: row.onboardedBy.name,
          role: roleName(row.onboardedBy.roleId),
        }
      : null,
    /** True for a self sign-up: the checker must pick an ASM when approving (DEC-074). */
    needsAsmPick: row.user.parent === null,
  }));

  return { items, meta: pageMeta(query.page, query.limit, total) };
}

// ---- One partner, everything the checker needs ----

/** Loads a submitted partner in the checker's scope; anything else is 404 (rule R2). */
async function loadForReview(actor: AuthUser, scope: PermissionScope, partnerId: string) {
  const profile = await prisma.partnerProfile.findFirst({
    where: { AND: [{ userId: partnerId }, queueWhere(actor, scope)] },
    select: {
      userId: true,
      kycState: true,
      user: {
        select: {
          status: true,
          zoneId: true,
          zone: { select: { id: true, name: true } },
          parentId: true,
        },
      },
    },
  });
  return assertInScope(profile, { user: actor, entity: "partner", id: partnerId });
}

/** Active ASMs in a zone: the choices when approving a self sign-up. */
function asmChoices(zoneId: string) {
  return prisma.user.findMany({
    where: { roleId: ROLE.ASM, zoneId, status: "active" },
    select: { id: true, name: true, phone: true },
    orderBy: { name: "asc" },
  });
}

export async function getForReview(actor: AuthUser, scope: PermissionScope, partnerId: string) {
  const base = await loadForReview(actor, scope, partnerId);
  const needsAsmPick = base.user.parentId === null;

  return {
    needsAsmPick,
    /** Only for a pending self sign-up: the ASMs the checker can pick from. */
    asmChoices:
      needsAsmPick && base.kycState === "pending" && base.user.zoneId
        ? await asmChoices(base.user.zoneId)
        : [],
    ...(await buildPartnerDetail(partnerId)),
  };
}

// ---- Approve, reject, undo ----

function wrongState(message: string): AppError {
  return new AppError(message, 409, "KYC_WRONG_STATE");
}

/**
 * Moves the state only if it is still `from` (a second checker acting at the same moment
 * finds nothing to update and is refused).
 */
async function moveState(
  tx: Prisma.TransactionClient,
  partnerId: string,
  from: "pending" | "rejected",
  data: Prisma.PartnerProfileUpdateManyMutationInput,
  message: string
): Promise<void> {
  const { count } = await tx.partnerProfile.updateMany({
    where: { userId: partnerId, kycState: from },
    data,
  });
  if (count === 0) throw wrongState(message);
}

/**
 * Module 8 hook: open the partner's points wallet when they are verified.
 * The wallet table does not exist yet; Module 8 fills this in (inside the same transaction).
 */
async function openWalletOnVerify(
  _tx: Prisma.TransactionClient,
  _partnerId: string
): Promise<void> {
  // Connected in Module 8 (wallets).
}

const NOT_PENDING = "This onboarding is not waiting for approval any more. Please refresh.";

export async function approve(
  actor: AuthUser,
  scope: PermissionScope,
  partnerId: string,
  asmId: string | undefined
) {
  const base = await loadForReview(actor, scope, partnerId);
  if (base.kycState !== "pending") throw wrongState(NOT_PENDING);
  if (base.user.status === "deactivated") {
    throw new AppError("This partner's account is deactivated.", 409, "PARTNER_DEACTIVATED");
  }

  // Self sign-up: the checker picks an active ASM of the partner's zone (DEC-074).
  let pickedAsmId: string | null = null;
  if (base.user.parentId === null) {
    if (!asmId) {
      throw new ValidationError("Pick an ASM for this partner.", [
        { path: "body.asmId", message: "Required for a partner who signed up on their own" },
      ]);
    }
    const asm = await prisma.user.findUnique({
      where: { id: asmId },
      select: { roleId: true, status: true, zoneId: true },
    });
    if (
      !asm ||
      asm.roleId !== ROLE.ASM ||
      asm.status !== "active" ||
      asm.zoneId !== base.user.zoneId
    ) {
      throw new AppError(
        `Pick an active ASM from the partner's zone (${base.user.zone?.name ?? "no zone"}).`,
        409,
        "ASM_NOT_IN_ZONE"
      );
    }
    pickedAsmId = asmId;
  } else if (asmId && asmId !== base.user.parentId) {
    throw new AppError(
      "This partner already has an ASM. To change it, move the partner after approval.",
      409,
      "ASM_ALREADY_SET"
    );
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await moveState(
      tx,
      partnerId,
      "pending",
      { kycState: "verified", reviewedAt: now, rejectionReason: null },
      NOT_PENDING
    );
    if (pickedAsmId) {
      await tx.user.update({ where: { id: partnerId }, data: { parentId: pickedAsmId } });
    }
    await tx.kycReview.create({
      data: { partnerId, action: "approved", actorId: actor.id, assignedAsmId: pickedAsmId },
    });
    await openWalletOnVerify(tx, partnerId);
    await recordAudit(tx, {
      actorId: actor.id,
      action: "partner.kyc_approve",
      entity: { type: "partner", id: partnerId },
      before: { kycState: "pending", asmId: base.user.parentId },
      after: { kycState: "verified", asmId: pickedAsmId ?? base.user.parentId, reviewedAt: now },
    });
  });

  return getForReview(actor, scope, partnerId);
}

export async function reject(
  actor: AuthUser,
  scope: PermissionScope,
  partnerId: string,
  reason: string
) {
  const base = await loadForReview(actor, scope, partnerId);
  if (base.kycState !== "pending") throw wrongState(NOT_PENDING);

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await moveState(
      tx,
      partnerId,
      "pending",
      { kycState: "rejected", reviewedAt: now, rejectionReason: reason },
      NOT_PENDING
    );
    await tx.kycReview.create({
      data: { partnerId, action: "rejected", reason, actorId: actor.id },
    });
    await recordAudit(tx, {
      actorId: actor.id,
      action: "partner.kyc_reject",
      entity: { type: "partner", id: partnerId },
      before: { kycState: "pending" },
      after: { kycState: "rejected", reason, reviewedAt: now },
    });
  });

  return getForReview(actor, scope, partnerId);
}

/** Admin only (DEC-074): back into the queue, to be checked again (DEC-098). */
export async function undoRejection(
  actor: AuthUser,
  scope: PermissionScope,
  partnerId: string,
  reason: string
) {
  const base = await loadForReview(actor, scope, partnerId);
  const notRejected = "This partner is not rejected. Please refresh.";
  if (base.kycState !== "rejected") throw wrongState(notRejected);

  await prisma.$transaction(async (tx) => {
    const before = await tx.partnerProfile.findUniqueOrThrow({
      where: { userId: partnerId },
      select: { rejectionReason: true },
    });
    await moveState(
      tx,
      partnerId,
      "rejected",
      { kycState: "pending", rejectionReason: null },
      notRejected
    );
    await tx.kycReview.create({
      data: { partnerId, action: "rejection_undone", reason, actorId: actor.id },
    });
    await recordAudit(tx, {
      actorId: actor.id,
      action: "partner.kyc_undo_rejection",
      entity: { type: "partner", id: partnerId },
      before: { kycState: "rejected", rejectionReason: before.rejectionReason },
      after: { kycState: "pending", reason },
    });
  });

  return getForReview(actor, scope, partnerId);
}

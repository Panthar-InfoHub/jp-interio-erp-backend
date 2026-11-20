import type { PermissionScope } from "../generated/prisma/enums.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { AppError } from "../utils/errors.js";
import type { PointsAdjustmentInput } from "../validators/pointsAdjustment.schema.js";
import { recordAudit } from "./audit.service.js";
import { postLedgerEntry } from "./ledger.service.js";
import { assertPartnerInScope, getLineForStaff, getPartnerWallet } from "./wallet.service.js";

/**
 * Manual points adjustment (Module 8 T6; DEC-020, DEC-021, DEC-128, DEC-131, DEC-135).
 * - Who: `ledger.adjust` = the Admin and the Rewards Sub-Admin (all partners). No approval step.
 * - Credit adds to available; a debit takes from available only, never below zero, and
 *   never touches held points (DEC-128). A frozen wallet is refused (DEC-131).
 * - The reason (10 – 500 characters) is required and shown to the partner; the staff
 *   name is not (DEC-133). No category and no double-click protection for now (DEC-135).
 * - The ledger line and the audit entry are saved in one transaction.
 */
export async function adjustPoints(
  me: AuthUser,
  scope: PermissionScope,
  partnerId: string,
  input: PointsAdjustmentInput
) {
  await assertPartnerInScope(me, scope, partnerId);

  // A partner who isn't verified has no wallet: a clear refusal, not a "bug" error.
  const hasWallet = await prisma.wallet.count({ where: { partnerId } });
  if (hasWallet === 0) {
    throw new AppError(
      "This partner has no wallet yet because they aren't verified, so points can't be adjusted.",
      409,
      "NO_WALLET"
    );
  }

  const entryId = await prisma.$transaction(async (tx) => {
    const { entry, wallet } = await postLedgerEntry(tx, {
      type: "adjust",
      partnerId,
      points: input.points,
      direction: input.direction,
      actorId: me.id,
      reason: input.reason,
    });
    const change = input.direction === "credit" ? input.points : -input.points;
    await recordAudit(tx, {
      actorId: me.id,
      action: "ledger.adjust",
      entity: { type: "partner", id: partnerId },
      before: {
        available: wallet.available - change,
        held: wallet.held,
        netAdjusted: wallet.netAdjusted - change,
      },
      after: {
        available: wallet.available,
        held: wallet.held,
        netAdjusted: wallet.netAdjusted,
        direction: input.direction,
        points: input.points,
        reason: input.reason,
        ledgerEntryId: entry.id,
      },
    });
    return entry.id;
  });

  const [line, wallet] = await Promise.all([
    getLineForStaff(me, entryId),
    getPartnerWallet(me, scope, partnerId),
  ]);
  return { line, wallet: wallet.wallet };
}

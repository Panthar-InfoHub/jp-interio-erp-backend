import { randomBytes } from "node:crypto";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { AppError, NotFoundError } from "../utils/errors.js";
import { recordAudit } from "./audit.service.js";
import { getSetting } from "./settings.service.js";
import { deleteFile } from "./storage.service.js";

/**
 * Draft clean-up (Module 5 T6, DEC-074, DEC-075, DEC-093).
 *
 * An onboarding that was never submitted and started more than `onboarding.draft_days`
 * days ago (default 30) is RETIRED, not deleted: the audit log points to the account and
 * can never change. Retiring:
 *   - switches the account off (deactivated) and ends its sessions;
 *   - releases the phone (a placeholder takes its place), so the number can sign up again;
 *   - deletes its KYC document and payout account rows (so the duplicate check does not
 *     block the same person later) and their photos in R2;
 *   - sets `draft_removed_at` and writes one audit row (actor: system).
 * Self sign-ups and field drafts alike. No warning is sent (DEC-093).
 * Safe to run twice: a draft already retired, or submitted meanwhile, is skipped.
 */

/** A phone placeholder: 15 characters that can never be a real number (real ones are digits). */
function releasedPhone(): string {
  return `x${randomBytes(7).toString("hex")}`;
}

export interface CleanupResult {
  days: number;
  retired: number;
  filesDeleted: number;
}

export async function removeExpiredDrafts(now = new Date()): Promise<CleanupResult> {
  const days = await getSetting("onboarding.draft_days");
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const expired = await prisma.partnerProfile.findMany({
    where: {
      kycState: "not_submitted",
      onboardingStep: { not: "submitted" },
      draftRemovedAt: null,
      onboardingStartedAt: { lt: cutoff },
    },
    select: { userId: true },
    take: 500,
  });

  let retired = 0;
  let filesDeleted = 0;

  for (const { userId } of expired) {
    try {
      const files = await retireDraft(userId, now, { by: "cleanup", days });
      if (files === null) continue;
      retired += 1;
      filesDeleted += await deleteFiles(files);
    } catch (error) {
      // One bad draft must not stop the others; it is tried again tomorrow.
      logger.error({ err: error, partnerId: userId }, "Draft clean-up failed for one draft");
    }
  }

  return { days, retired, filesDeleted };
}

/** Deletes R2 photos after the transaction (never throws). Returns how many were tried. */
async function deleteFiles(fileUrls: string[]): Promise<number> {
  for (const fileUrl of fileUrls) await deleteFile(fileUrl);
  return fileUrls.length;
}

/** Who is retiring the draft: the daily clean-up, or an Admin by hand (DEC-096, DEC-097). */
type RetiredBy = { by: "cleanup"; days: number } | { by: "admin"; actorId: string; reason: string };

/** Retires one draft in one transaction. Returns its photo URLs, or null if skipped. */
async function retireDraft(
  partnerId: string,
  now: Date,
  retiredBy: RetiredBy
): Promise<string[] | null> {
  return prisma.$transaction(async (tx) => {
    // Guarded: if it was submitted or retired a moment ago, leave it alone.
    const { count } = await tx.partnerProfile.updateMany({
      where: { userId: partnerId, kycState: "not_submitted", draftRemovedAt: null },
      data: { draftRemovedAt: now },
    });
    if (count === 0) return null;

    const profile = await tx.partnerProfile.findUniqueOrThrow({
      where: { userId: partnerId },
      select: {
        onboardingStep: true,
        onboardingStartedAt: true,
        onboardedById: true,
        user: { select: { phone: true, status: true } },
        kycDocuments: { select: { fileUrl: true } },
        _count: { select: { payoutAccounts: true, kycDocuments: true } },
      },
    });

    await tx.kycDocument.deleteMany({ where: { partnerId } });
    await tx.payoutAccount.deleteMany({ where: { partnerId } });
    await tx.user.update({
      where: { id: partnerId },
      data: { status: "deactivated", phone: releasedPhone() },
    });
    await tx.session.updateMany({
      where: { userId: partnerId, revokedAt: null },
      data: { revokedAt: now, revokeReason: "user_deactivated" },
    });

    await recordAudit(tx, {
      actorId: retiredBy.by === "admin" ? retiredBy.actorId : null,
      action: "partner.draft_removed",
      entity: { type: "partner", id: partnerId },
      before: {
        phone: profile.user.phone,
        status: profile.user.status,
        onboardingStep: profile.onboardingStep,
        onboardingStartedAt: profile.onboardingStartedAt,
        startedBy: profile.onboardedById ?? "self",
      },
      after: {
        status: "deactivated",
        phoneReleased: true,
        kycDocumentsDeleted: profile._count.kycDocuments,
        payoutAccountsDeleted: profile._count.payoutAccounts,
        ...(retiredBy.by === "cleanup"
          ? { removedBy: "cleanup", draftDays: retiredBy.days }
          : { removedBy: "admin", reason: retiredBy.reason }),
      },
    });

    return profile.kycDocuments.map((doc) => doc.fileUrl);
  });
}

// ---- Admin: "Remove this draft now" (Module 5 T7, DEC-096, DEC-097) ----

function notADraft(): AppError {
  return new AppError(
    "This partner has already submitted their onboarding, so it cannot be removed as a draft.",
    409,
    "NOT_A_DRAFT"
  );
}

/**
 * Retires one unfinished draft immediately, exactly like the daily clean-up, and frees its
 * phone and numbers. Admin only; a reason is required and saved in the audit log.
 */
export async function removeDraftNow(actor: AuthUser, partnerId: string, reason: string) {
  const profile = await prisma.partnerProfile.findUnique({
    where: { userId: partnerId },
    select: { kycState: true, onboardingStep: true, draftRemovedAt: true },
  });
  // Not a partner, or already retired (retired drafts are hidden everywhere).
  if (!profile || profile.draftRemovedAt) throw new NotFoundError("Partner not found");
  if (profile.kycState !== "not_submitted" || profile.onboardingStep === "submitted") {
    throw notADraft();
  }

  const files = await retireDraft(partnerId, new Date(), {
    by: "admin",
    actorId: actor.id,
    reason,
  });
  // Submitted (or retired) a moment ago, between the check above and the transaction.
  if (files === null) throw notADraft();

  const filesDeleted = await deleteFiles(files);
  return { partnerId, removed: true, filesDeleted };
}

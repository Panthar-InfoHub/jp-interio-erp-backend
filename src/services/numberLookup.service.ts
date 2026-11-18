import { ROLES } from "../config/roles.js";
import type { KycDocType, PayoutMethod } from "../generated/prisma/enums.js";
import { protectSensitive } from "../lib/crypto/sensitiveData.js";
import { prisma } from "../lib/prisma.js";
import type { NumberLookupInput } from "../validators/partner.schema.js";

/**
 * Admin: "who holds this number?" (Module 5 T7, DEC-097).
 *
 * When a person is told their PAN / Aadhaar / GST / bank account / UPI ID "is already
 * registered", support types that number here and sees which partner holds it. If that
 * partner is an unfinished draft, the Admin can remove it now (draftCleanup.service.ts).
 *
 * The search uses the fingerprint (hash), so nothing is decrypted. It finds every row the
 * duplicate check counts: current documents, replaced documents and removed accounts.
 * Retired drafts have no rows left, so they never show up.
 */

type Target =
  { table: "document"; docType: KycDocType } | { table: "payout"; method: PayoutMethod };

const TARGET: Record<NumberLookupInput["type"], Target> = {
  pan: { table: "document", docType: "pan" },
  aadhaar: { table: "document", docType: "aadhaar" },
  gst: { table: "document", docType: "gst" },
  bank_account: { table: "payout", method: "bank" },
  upi: { table: "payout", method: "upi" },
};

/** The fingerprint the duplicate check uses for this number. Bad formats are a 400. */
function fingerprint(input: NumberLookupInput): string {
  if (input.type === "bank_account") {
    return protectSensitive("bank_account", input.number, { ifsc: input.ifsc }).hash;
  }
  return protectSensitive(input.type, input.number).hash;
}

export async function findNumberHolder(input: NumberLookupInput) {
  const hash = fingerprint(input);
  const target = TARGET[input.type];

  // partnerId → is the number still in use there (not replaced / removed)?
  const inUse = new Map<string, boolean>();
  if (target.table === "document") {
    const rows = await prisma.kycDocument.findMany({
      where: { docType: target.docType, numberHash: hash },
      select: { partnerId: true, replacedAt: true },
    });
    for (const row of rows) {
      inUse.set(row.partnerId, (inUse.get(row.partnerId) ?? false) || row.replacedAt === null);
    }
  } else {
    const rows = await prisma.payoutAccount.findMany({
      where: { method: target.method, valueHash: hash },
      select: { partnerId: true, removedAt: true },
    });
    for (const row of rows) {
      inUse.set(row.partnerId, (inUse.get(row.partnerId) ?? false) || row.removedAt === null);
    }
  }

  if (inUse.size === 0) return { found: false, holders: [] };

  const profiles = await prisma.partnerProfile.findMany({
    where: { userId: { in: [...inUse.keys()] } },
    select: {
      userId: true,
      partnerType: true,
      businessName: true,
      kycState: true,
      onboardingStep: true,
      onboardingStartedAt: true,
      submittedAt: true,
      draftRemovedAt: true,
      user: {
        select: {
          name: true,
          phone: true,
          status: true,
          zone: { select: { id: true, name: true } },
        },
      },
      onboardedBy: { select: { id: true, name: true, roleId: true } },
    },
  });

  const holders = profiles.map((profile) => {
    const isDraft =
      profile.kycState === "not_submitted" &&
      profile.onboardingStep !== "submitted" &&
      profile.draftRemovedAt === null;
    return {
      partnerId: profile.userId,
      name: profile.user.name,
      phone: profile.user.phone,
      partnerType: profile.partnerType,
      businessName: profile.businessName,
      zone: profile.user.zone,
      accountStatus: profile.user.status,
      kycState: profile.kycState,
      // `partner_type` is no longer a step (DEC-087).
      onboardingStep:
        profile.onboardingStep === "partner_type" ? "basic_info" : profile.onboardingStep,
      startedAt: profile.onboardingStartedAt,
      submittedAt: profile.submittedAt,
      /** null = the partner signed up on their own. */
      startedBy: profile.onboardedBy
        ? {
            id: profile.onboardedBy.id,
            name: profile.onboardedBy.name,
            role: ROLES.find((role) => role.id === profile.onboardedBy?.roleId)?.name ?? null,
          }
        : null,
      /** "in_use", or "replaced_or_removed" (an old copy, which still blocks the number). */
      numberStatus: inUse.get(profile.userId) ? "in_use" : "replaced_or_removed",
      /** True only for an unfinished draft: the Admin may remove it now (DEC-096). */
      canRemoveDraft: isDraft,
    };
  });

  return { found: true, holders };
}

import { Prisma } from "../generated/prisma/client.js";
import type { PermissionScope } from "../generated/prisma/enums.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { AppError, ValidationError } from "../utils/errors.js";
import type { ProfileEditInput } from "../validators/partnerProfile.schema.js";
import { recordAudit } from "./audit.service.js";
import { getOnboarding } from "./onboarding.service.js";
import { assertInScope, scopeForPartners } from "./scope.service.js";
import { revokeAllSessions } from "./session.service.js";

/**
 * Profile edits and mobile number change, after verification (Module 5 T11;
 * DEC-074 – DEC-076, DEC-103).
 *
 * Edit basic details: the partner (`partner.self`) and staff with `partners.edit`
 * (SE assigned, ASM own, ZH zone, Partners & KYC Sub-Admin and Admin all). No approval.
 * Change the phone: staff only (`partners.edit`), no OTP; the partner is logged out
 * everywhere and the old number becomes free.
 * Never here: zone (move partner), partner type, GST / PAN / Aadhaar.
 * Verified partners only; each change is one transaction with one audit row.
 */

const profileSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  partnerProfile: {
    select: {
      kycState: true,
      partnerType: true,
      businessName: true,
      address: true,
      city: true,
      state: true,
      pincode: true,
      ownerDob: true,
      ownerAnniversaryDate: true,
      ownerSpouseName: true,
    },
  },
} satisfies Prisma.UserSelect;

/** The partner, if the actor may see them (404) and they are verified (409). */
async function loadVerifiedPartner(actor: AuthUser, scope: PermissionScope, partnerId: string) {
  const partner = await prisma.user.findFirst({
    where: { AND: [{ id: partnerId }, scopeForPartners(actor, scope)] },
    select: profileSelect,
  });
  const found = assertInScope(partner, { user: actor, entity: "partner", id: partnerId });
  const profile = found.partnerProfile;
  if (!profile || profile.kycState !== "verified") {
    throw new AppError(
      "Details can be changed only after the partner is verified.",
      409,
      "PARTNER_NOT_VERIFIED"
    );
  }
  return { ...found, profile };
}

const isoDate = (value: Date | null | undefined) =>
  value ? value.toISOString().slice(0, 10) : null;

// ---- Edit basic details (DEC-075, DEC-076, DEC-103) ----

export async function editProfile(
  actor: AuthUser,
  scope: PermissionScope,
  partnerId: string,
  input: ProfileEditInput
) {
  const partner = await loadVerifiedPartner(actor, scope, partnerId);
  const isFirm = partner.profile.partnerType === "dealer" || partner.profile.partnerType === "oem";

  const directorFields = ["ownerDob", "ownerAnniversaryDate", "ownerSpouseName"] as const;
  if (!isFirm && directorFields.some((field) => input[field] !== undefined)) {
    throw new ValidationError("Director's details are only for dealers and OEMs.");
  }
  if (isFirm && input.businessName === null) {
    throw new ValidationError("Firm name is required for a dealer or OEM.");
  }

  const userData: Prisma.UserUpdateInput = {};
  const profileData: Prisma.PartnerProfileUpdateInput = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};

  const change = <T>(
    field: string,
    oldValue: T,
    newValue: T | undefined,
    target: "user" | "profile"
  ) => {
    if (newValue === undefined) return;
    const oldShown = oldValue instanceof Date ? isoDate(oldValue) : oldValue;
    const newShown = newValue instanceof Date ? isoDate(newValue) : newValue;
    if (oldShown === newShown) return;
    (target === "user" ? userData : profileData)[field as never] = newValue as never;
    before[field] = oldShown;
    after[field] = newShown;
  };

  change("name", partner.name, input.name, "user");
  change("email", partner.email, input.email, "user");
  change("address", partner.profile.address, input.address, "profile");
  change("city", partner.profile.city, input.city, "profile");
  change("state", partner.profile.state, input.state, "profile");
  change("pincode", partner.profile.pincode, input.pincode, "profile");
  change("businessName", partner.profile.businessName, input.businessName, "profile");
  change("ownerDob", partner.profile.ownerDob, input.ownerDob, "profile");
  change(
    "ownerAnniversaryDate",
    partner.profile.ownerAnniversaryDate,
    input.ownerAnniversaryDate,
    "profile"
  );
  change("ownerSpouseName", partner.profile.ownerSpouseName, input.ownerSpouseName, "profile");

  const changed = Object.keys(after).length > 0;
  if (changed) {
    await prisma.$transaction(async (tx) => {
      // Guarded: still verified at the moment of writing.
      const { count } = await tx.partnerProfile.updateMany({
        where: { userId: partnerId, kycState: "verified" },
        data: { updatedAt: new Date() },
      });
      if (count === 0) {
        throw new AppError(
          "Details can be changed only after the partner is verified.",
          409,
          "PARTNER_NOT_VERIFIED"
        );
      }
      if (Object.keys(userData).length > 0) {
        await tx.user.update({ where: { id: partnerId }, data: userData });
      }
      if (Object.keys(profileData).length > 0) {
        await tx.partnerProfile.update({ where: { userId: partnerId }, data: profileData });
      }
      await recordAudit(tx, {
        actorId: actor.id,
        action: "partner.profile_edit",
        entity: { type: "partner", id: partnerId },
        before,
        after,
      });
    });
  }

  return { changed, onboarding: await getOnboarding(partnerId) };
}

// ---- Change the mobile number: staff only (DEC-074, DEC-075, DEC-103) ----

function phoneTaken(): AppError {
  return new AppError("This phone number is already registered.", 409, "PHONE_ALREADY_REGISTERED");
}

export async function changePhone(
  actor: AuthUser,
  scope: PermissionScope,
  partnerId: string,
  newPhone: string
) {
  const partner = await loadVerifiedPartner(actor, scope, partnerId);
  if (partner.phone === newPhone) {
    throw new AppError("This is already the partner's phone number.", 409, "SAME_PHONE");
  }
  const taken = await prisma.user.findUnique({ where: { phone: newPhone }, select: { id: true } });
  if (taken) throw phoneTaken();

  let sessionsEnded = 0;
  try {
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({
        where: {
          id: partnerId,
          phone: partner.phone,
          partnerProfile: { is: { kycState: "verified" } },
        },
        data: { phone: newPhone },
      });
      if (count === 0) {
        throw new AppError(
          "The partner's details changed a moment ago. Please refresh.",
          409,
          "PARTNER_CHANGED"
        );
      }
      await recordAudit(tx, {
        actorId: actor.id,
        action: "partner.phone_change",
        entity: { type: "partner", id: partnerId },
        before: { phone: partner.phone },
        after: { phone: newPhone },
      });
      // Logged out everywhere; they log in again with the new number (DEC-074).
      sessionsEnded = await revokeAllSessions(tx, {
        userId: partnerId,
        reason: "admin_revoked",
        actorId: actor.id,
      });
    });
  } catch (error) {
    // Two changes to the same new number at the same moment: the unique rule stops one.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw phoneTaken();
    }
    throw error;
  }

  return { partnerId, phone: newPhone, loggedOutSessions: sessionsEnded };
}

import { ROLE } from "../config/roles.js";
import { prisma } from "../lib/prisma.js";
import { NotFoundError } from "../utils/errors.js";

/**
 * "My status" for the Partner App (Module 5 T9; DEC-073, DEC-075, DEC-100).
 * One answer tells the app which screen to open and whom the partner can contact.
 *
 *   onboarding → "Complete your sign-up" (or "being set up by {staff}": that staff member)
 *   pending    → "Your KYC is under review"                       (no contact, DEC-100)
 *   verified   → home screen; their ASM and Sales Executive       (DEC-073)
 *   rejected   → the reason; their zone's Zonal Head, if there is one (DEC-075, DEC-100)
 *
 * Suspended and deactivated partners never reach this: login and every request refuse
 * them with 403 ACCOUNT_INACTIVE (Module 2), and the app shows that message.
 */

type Contact = { role: string; name: string | null; phone: string };

const contact = (role: string, person: { name: string | null; phone: string } | null) =>
  person ? [{ role, name: person.name, phone: person.phone }] : [];

export async function getMyStatus(partnerId: string) {
  const profile = await prisma.partnerProfile.findUnique({
    where: { userId: partnerId },
    select: {
      kycState: true,
      submittedAt: true,
      reviewedAt: true,
      rejectionReason: true,
      draftRemovedAt: true,
      user: {
        select: {
          name: true,
          zoneId: true,
          parent: { select: { name: true, phone: true, status: true } },
        },
      },
      salesExecutive: { select: { name: true, phone: true, status: true } },
      onboardedBy: { select: { name: true, phone: true } },
    },
  });
  if (!profile || profile.draftRemovedAt) throw new NotFoundError("Partner not found");

  // Only active staff are shown as contacts.
  const active = <T extends { status: string }>(person: T | null) =>
    person && person.status === "active" ? person : null;

  switch (profile.kycState) {
    case "not_submitted": {
      const setUpBy = profile.onboardedBy;
      return {
        state: "onboarding" as const,
        message: setUpBy
          ? `Your account is being set up by ${setUpBy.name ?? "our team"}. You can also finish it yourself.`
          : "Complete your sign-up to start earning points.",
        contacts: contact("Set up by", setUpBy) as Contact[],
      };
    }

    case "pending":
      return {
        state: "pending" as const,
        message: "Your KYC is under review.",
        submittedAt: profile.submittedAt,
        contacts: [] as Contact[],
      };

    case "verified":
      return {
        state: "verified" as const,
        message: "Your account is verified.",
        verifiedAt: profile.reviewedAt,
        contacts: [
          ...contact("ASM", active(profile.user.parent)),
          ...contact("Sales Executive", active(profile.salesExecutive)),
        ] as Contact[],
      };

    case "rejected": {
      const zonalHead = profile.user.zoneId
        ? await prisma.user.findFirst({
            where: { roleId: ROLE.ZONAL_HEAD, zoneId: profile.user.zoneId, status: "active" },
            select: { name: true, phone: true },
          })
        : null;
      return {
        state: "rejected" as const,
        message: "Your application was rejected.",
        rejectionReason: profile.rejectionReason,
        rejectedAt: profile.reviewedAt,
        // No Zonal Head in the zone right now → no contact (DEC-100).
        contacts: contact("Zonal Head", zonalHead) as Contact[],
      };
    }
  }
}

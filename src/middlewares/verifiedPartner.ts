import type { RequestHandler } from "express";
import { ROLE } from "../config/roles.js";
import type { KycState } from "../generated/prisma/enums.js";
import { prisma } from "../lib/prisma.js";
import { AppError, ForbiddenError } from "../utils/errors.js";
import { getAuthUser } from "./auth.js";

/**
 * The "verified partner" guard (Module 5 T12; DEC-073, DEC-104). Use after `requireAuth`
 * on every Partner App feature that needs a verified partner:
 *
 *   router.post("/scan", requireAuth, requireVerifiedPartner, requirePermission("scans.create"), ...)
 *
 * Used by: partner catalog (Module 6), QR scan (Module 8), cash-out (Module 10),
 * shipment / sample requests (Module 11).
 *
 * - Not a partner (staff) → 403 FORBIDDEN.
 * - Unfinished, pending or rejected → 403 PARTNER_NOT_VERIFIED, `details.kycState` says which,
 *   and the message fits it. The app can call `GET /partner/status` to show the right screen.
 * - Suspended / deactivated never get here: `requireAuth` already refuses them (Module 2).
 *
 * The state is read from the database on each request (not from the token), so an approval
 * or a rejection takes effect at once.
 */

const MESSAGES: Record<Exclude<KycState, "verified">, string> = {
  not_submitted: "Please complete your sign-up first. You can use this once you are verified.",
  pending: "Your KYC is under review. You can use this once you are verified.",
  rejected: "Your application was rejected, so this is not available.",
};

export const requireVerifiedPartner: RequestHandler = async (req, _res, next) => {
  const user = getAuthUser(req);
  if (user.roleId !== ROLE.PARTNER) throw new ForbiddenError();

  const profile = await prisma.partnerProfile.findUnique({
    where: { userId: user.id },
    select: { kycState: true },
  });
  const kycState = profile?.kycState ?? "not_submitted";

  if (kycState !== "verified") {
    throw new AppError(MESSAGES[kycState], 403, "PARTNER_NOT_VERIFIED", { kycState });
  }
  next();
};

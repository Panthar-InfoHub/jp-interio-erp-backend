import { ROLES } from "../config/roles.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { SessionRevokeReason } from "../generated/prisma/enums.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { NotFoundError } from "../utils/errors.js";
import { recordAudit } from "./audit.service.js";

/** A session that is still open: not ended and not expired. */
const openSession = () => ({ revokedAt: null, expiresAt: { gt: new Date() } });

/** GET /auth/me — who am I: user, role, zone, and for partners the KYC state. */
export async function getMe(authUser: AuthUser) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: authUser.id },
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      roleId: true,
      parentId: true,
      createdAt: true,
      zone: { select: { id: true, name: true, code: true } },
      partnerProfile: { select: { kycState: true, partnerType: true, businessName: true } },
    },
  });
  const role = ROLES.find((r) => r.id === user.roleId);

  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    email: user.email,
    role: role && { id: role.id, key: role.key, name: role.name, tier: role.tier },
    app: authUser.app,
    zone: user.zone,
    parentId: user.parentId,
    subAdminAreas: authUser.subAdminAreas,
    /** Partners only; null for staff. */
    partner: user.partnerProfile,
    createdAt: user.createdAt,
  };
}

/** GET /auth/sessions — my open devices, newest use first. Only hashes are stored, never shown. */
export async function listSessions(authUser: AuthUser) {
  const sessions = await prisma.session.findMany({
    where: { userId: authUser.id, ...openSession() },
    orderBy: [{ lastUsedAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      app: true,
      deviceId: true,
      deviceName: true,
      ip: true,
      userAgent: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
    },
  });
  return sessions.map((session) => ({ ...session, isCurrent: session.id === authUser.sessionId }));
}

/**
 * DELETE /auth/sessions/:id — log out one of my devices.
 * Someone else's session (or an unknown id) is a 404. Ending an already-ended session is fine.
 * Returns true when it was this device, so the controller can clear the web cookie.
 */
export async function revokeOwnSession(authUser: AuthUser, sessionId: string): Promise<boolean> {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId: authUser.id },
    select: { id: true, revokedAt: true },
  });
  if (!session) throw new NotFoundError("Session not found");

  if (!session.revokedAt) {
    await prisma.$transaction(async (tx) => {
      const ended = await tx.session.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: "logout" },
      });
      if (ended.count === 0) return;
      await recordAudit(tx, {
        actorId: authUser.id,
        action: "session.revoke",
        entity: { type: "session", id: session.id },
        after: { reason: "logout", fromSessionId: authUser.sessionId },
      });
    });
  }
  return session.id === authUser.sessionId;
}

/** POST /auth/logout — log out this device. */
export async function logout(authUser: AuthUser): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const ended = await tx.session.updateMany({
      where: { id: authUser.sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: "logout" },
    });
    if (ended.count === 0) return;
    await recordAudit(tx, {
      actorId: authUser.id,
      action: "auth.logout",
      entity: { type: "session", id: authUser.sessionId },
    });
  });
}

/** POST /auth/logout-all — log out every device, this one included (user's choice, DEC-041). */
export async function logoutAll(authUser: AuthUser): Promise<number> {
  return prisma.$transaction((tx) =>
    revokeAllSessions(tx, { userId: authUser.id, reason: "logout_all", actorId: authUser.id })
  );
}

/**
 * Ends every open session of a user and writes one audit row (only if something was ended).
 * Pass the transaction of the change that causes it, e.g. Module 4's deactivate:
 *   await revokeAllSessions(tx, { userId, reason: "user_deactivated", actorId: admin.id });
 * Returns how many sessions were ended.
 */
export async function revokeAllSessions(
  tx: Prisma.TransactionClient,
  input: { userId: string; reason: SessionRevokeReason; actorId: string | null }
): Promise<number> {
  const ended = await tx.session.updateMany({
    where: { userId: input.userId, ...openSession() },
    data: { revokedAt: new Date(), revokeReason: input.reason },
  });
  if (ended.count > 0) {
    await recordAudit(tx, {
      actorId: input.actorId,
      action: "session.revoke_all",
      entity: { type: "user", id: input.userId },
      after: { reason: input.reason, sessionsEnded: ended.count },
    });
  }
  return ended.count;
}

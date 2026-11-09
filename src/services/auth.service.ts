import { randomInt } from "node:crypto";
import { ROLE, ROLES } from "../config/roles.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { AppType, KycState } from "../generated/prisma/enums.js";
import {
  ACCESS_TOKEN_MINUTES,
  createAccessToken,
  createRefreshToken,
  hashOtp,
  hashRefreshToken,
  hashesMatch,
  sessionExpiresAt,
} from "../lib/auth/tokens.js";
import { recordAudit } from "./audit.service.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { getSmsSender } from "../lib/sms/index.js";
import { getTestOtp, isTestPhone } from "../lib/sms/testPhones.js";
import { AppError } from "../utils/errors.js";
import { getSetting } from "./settings.service.js";

/** The user fields a login or refresh needs. */
const loginUserSelect = {
  id: true,
  name: true,
  phone: true,
  roleId: true,
  status: true,
  partnerProfile: { select: { kycState: true } },
} satisfies Prisma.UserSelect;

type LoginUser = Prisma.UserGetPayload<{ select: typeof loginUserSelect }>;

const APP_NAMES: Record<AppType, string> = {
  web: "the web console",
  field: "the field app",
  partner: "the partner app",
};

/**
 * Who may ask for an OTP for which app (clear messages, DEC-037):
 * - partner app: a new number (the account is made at verify) or an active Partner;
 * - field app / web console: an existing, active user whose role belongs to that app.
 * Staff accounts are never created by logging in.
 */
async function assertPhoneMayLogIn(
  phone: string,
  app: AppType,
  db: Prisma.TransactionClient = prisma
) {
  const user = await db.user.findUnique({ where: { phone }, select: loginUserSelect });

  if (!user) {
    if (app === "partner") return null;
    throw new AppError(
      `This number is not registered for ${APP_NAMES[app]}.`,
      403,
      "PHONE_NOT_REGISTERED"
    );
  }

  const roleApp = ROLES.find((role) => role.id === user.roleId)?.app;
  if (roleApp !== app) {
    throw new AppError(
      `This number is not registered for ${APP_NAMES[app]}.`,
      403,
      "PHONE_NOT_REGISTERED"
    );
  }

  if (user.status !== "active") {
    throw new AppError(
      `This account is ${user.status}. Please contact your manager.`,
      403,
      "ACCOUNT_INACTIVE"
    );
  }

  return user;
}

/** A random OTP of `length` digits, e.g. "048213". */
function generateOtp(length: number): string {
  return randomInt(0, 10 ** length)
    .toString()
    .padStart(length, "0");
}

/**
 * Step 1 of login: checks the phone may use this app, enforces the resend wait,
 * saves the OTP's hash and sends it (test phones get the fixed OTP and no SMS).
 * Only the newest OTP for a phone + app can be used at verify (Task 6).
 * Not audited: the otp_codes row is the record (DEC-037).
 */
export async function requestOtp(input: {
  phone: string;
  app: AppType;
  ip: string | undefined;
}): Promise<{ expiresInSeconds: number; resendAfterSeconds: number }> {
  const { phone, app, ip } = input;

  await assertPhoneMayLogIn(phone, app);

  const [otpLength, expiryMinutes, resendWaitSeconds] = await Promise.all([
    getSetting("otp.length"),
    getSetting("otp.expiry_minutes"),
    getSetting("otp.resend_wait_seconds"),
  ]);

  // Resend wait: one OTP per phone + app every `resendWaitSeconds`.
  const latest = await prisma.otpCode.findFirst({
    where: { phone, app },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (latest) {
    const secondsSince = (Date.now() - latest.createdAt.getTime()) / 1000;
    if (secondsSince < resendWaitSeconds) {
      const retryAfterSeconds = Math.ceil(resendWaitSeconds - secondsSince);
      throw new AppError(
        `Please wait ${retryAfterSeconds} seconds before asking for a new OTP.`,
        429,
        "OTP_RESEND_WAIT",
        { retryAfterSeconds }
      );
    }
  }

  const testPhone = isTestPhone(phone);
  const otp = testPhone ? getTestOtp() : generateOtp(otpLength);

  const saved = await prisma.otpCode.create({
    data: {
      phone,
      app,
      codeHash: hashOtp(phone, app, otp),
      expiresAt: new Date(Date.now() + expiryMinutes * 60 * 1000),
      ip: ip ?? null,
    },
    select: { id: true },
  });

  if (testPhone) {
    logger.info({ phone, app }, "Test phone: OTP not sent by SMS");
  } else {
    try {
      await getSmsSender().sendOtp(phone, otp);
    } catch (error) {
      // The user never got this OTP: remove it so they can ask again straight away.
      await prisma.otpCode.delete({ where: { id: saved.id } });
      throw error;
    }
  }

  return { expiresInSeconds: expiryMinutes * 60, resendAfterSeconds: resendWaitSeconds };
}

export interface LoginResult {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  /** The controller puts this in a cookie (web) or the reply body (apps). */
  refreshToken: string;
  refreshExpiresAt: Date;
  user: {
    id: string;
    name: string | null;
    phone: string;
    role: { id: number; key: string; name: string };
    /** True when this login just created the partner's account (go to onboarding). */
    isNewPartner: boolean;
    /** Partners only; null for staff. */
    kycState: KycState | null;
  };
}

const NO_OTP_MESSAGE = "No active OTP for this number. Please ask for a new one.";

/**
 * Step 2 of login: checks the OTP and opens a session (DEC-038).
 * - Only the newest OTP for the phone + app counts (DEC-037).
 * - A wrong OTP adds one try and says how many are left; at `otp.max_attempts` it dies.
 * - A new partner's account is created here (name empty until onboarding).
 * - Partners: one device only, so their other sessions are ended (DEC-032).
 * Everything that changes data runs in one transaction, with audit rows.
 */
export async function verifyOtp(input: {
  phone: string;
  app: AppType;
  otp: string;
  deviceId: string | undefined;
  deviceName: string | undefined;
  ip: string | undefined;
  userAgent: string | undefined;
}): Promise<LoginResult> {
  const { phone, app } = input;

  const maxAttempts = await getSetting("otp.max_attempts");

  const latest = await prisma.otpCode.findFirst({
    where: { phone, app },
    orderBy: { createdAt: "desc" },
    select: { id: true, codeHash: true, attempts: true, expiresAt: true, usedAt: true },
  });

  if (!latest || latest.usedAt) {
    throw new AppError(NO_OTP_MESSAGE, 400, "OTP_NOT_FOUND");
  }
  if (latest.expiresAt.getTime() <= Date.now()) {
    throw new AppError("This OTP has expired. Please ask for a new one.", 400, "OTP_EXPIRED");
  }
  if (latest.attempts >= maxAttempts) {
    throw new AppError(
      "Too many wrong tries. Please ask for a new OTP.",
      400,
      "OTP_TOO_MANY_ATTEMPTS"
    );
  }

  if (!hashesMatch(hashOtp(phone, app, input.otp), latest.codeHash)) {
    // Count the wrong try in the database itself, so two requests at once can't both slip by.
    const counted = await prisma.otpCode.updateMany({
      where: { id: latest.id, usedAt: null, attempts: { lt: maxAttempts } },
      data: { attempts: { increment: 1 } },
    });
    const attemptsLeft = counted.count === 0 ? 0 : Math.max(0, maxAttempts - latest.attempts - 1);
    throw new AppError(
      attemptsLeft > 0
        ? `Wrong OTP. ${attemptsLeft} ${attemptsLeft === 1 ? "try" : "tries"} left.`
        : "Wrong OTP. No tries left; please ask for a new OTP.",
      401,
      "OTP_WRONG",
      { attemptsLeft }
    );
  }

  // Settings are read before the transaction, so it stays short.
  const expiresAt = await sessionExpiresAt(app);
  const refresh = createRefreshToken();

  const { user, sessionId, isNewPartner } = await prisma.$transaction(async (tx) => {
    // Use the OTP once. If another request used it a moment ago, stop here.
    const used = await tx.otpCode.updateMany({
      where: {
        id: latest.id,
        usedAt: null,
        attempts: { lt: maxAttempts },
        expiresAt: { gt: new Date() },
      },
      data: { usedAt: new Date() },
    });
    if (used.count === 0) throw new AppError(NO_OTP_MESSAGE, 400, "OTP_NOT_FOUND");

    // Checked again: the account may have changed since the OTP was sent.
    let user = await assertPhoneMayLogIn(phone, app, tx);
    let isNewPartner = false;

    if (!user) {
      // Only the partner app gets here (assertPhoneMayLogIn refuses the others).
      user = await tx.user.create({
        data: { phone, roleId: ROLE.PARTNER, partnerProfile: { create: {} } },
        select: loginUserSelect,
      });
      isNewPartner = true;
      await recordAudit(tx, {
        actorId: user.id,
        action: "user.create",
        entity: { type: "user", id: user.id },
        after: { phone, roleId: ROLE.PARTNER, status: user.status, via: "partner_otp_login" },
      });
    }

    if (user.roleId === ROLE.PARTNER) {
      // One device only (DEC-032): end the partner's other open sessions.
      const ended = await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { revokedAt: new Date(), revokeReason: "new_device_login" },
      });
      if (ended.count > 0) {
        await recordAudit(tx, {
          actorId: user.id,
          action: "session.revoke",
          entity: { type: "user", id: user.id },
          after: { reason: "new_device_login", sessionsEnded: ended.count },
        });
      }
    }

    const session = await tx.session.create({
      data: {
        userId: user.id,
        app,
        refreshTokenHash: refresh.hash,
        deviceId: input.deviceId ?? null,
        deviceName: input.deviceName ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent?.slice(0, 500) ?? null,
        expiresAt,
      },
      select: { id: true },
    });

    await recordAudit(tx, {
      actorId: user.id,
      action: "auth.login",
      entity: { type: "session", id: session.id },
      after: { app, deviceName: input.deviceName ?? null, isNewPartner },
    });

    return { user, sessionId: session.id, isNewPartner };
  });

  return buildLoginResult(user, sessionId, app, refresh.token, expiresAt, isNewPartner);
}

/** The reply shared by login and refresh. */
function buildLoginResult(
  user: LoginUser,
  sessionId: string,
  app: AppType,
  refreshToken: string,
  refreshExpiresAt: Date,
  isNewPartner: boolean
): LoginResult {
  const role = ROLES.find((r) => r.id === user.roleId);
  if (!role) throw new Error(`Unknown role id ${user.roleId}`);

  return {
    accessToken: createAccessToken({ userId: user.id, sessionId, roleId: user.roleId, app }),
    expiresIn: ACCESS_TOKEN_MINUTES * 60,
    refreshToken,
    refreshExpiresAt,
    user: {
      id: user.id,
      name: user.name,
      phone: user.phone,
      role: { id: role.id, key: role.key, name: role.name },
      isNewPartner,
      kycState: user.partnerProfile?.kycState ?? null,
    },
  };
}

const LOG_IN_AGAIN = "Your session has ended. Please log in again.";

/**
 * Swaps a refresh token for a new access token + a new refresh token (rotation, DEC-039).
 * - The old refresh token stops working; it is kept as `previousTokenHash`.
 * - Seeing that old token again means it was copied: only that session is ended.
 * - Each refresh restarts the session clock (7 days web, 60 days apps).
 * A normal refresh is not audited (it happens every 15 minutes); a stolen-token end is.
 */
export async function refreshSession(input: {
  refreshToken: string;
  ip: string | undefined;
  userAgent: string | undefined;
}): Promise<LoginResult> {
  const hash = hashRefreshToken(input.refreshToken);

  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: hash },
    select: {
      id: true,
      app: true,
      expiresAt: true,
      revokedAt: true,
      user: { select: loginUserSelect },
    },
  });

  if (!session) {
    await endSessionIfTokenReused(hash);
    throw new AppError(LOG_IN_AGAIN, 401, "INVALID_REFRESH_TOKEN");
  }
  if (session.revokedAt) {
    throw new AppError(LOG_IN_AGAIN, 401, "SESSION_ENDED");
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    throw new AppError("Your session has expired. Please log in again.", 401, "SESSION_EXPIRED");
  }
  if (session.user.status !== "active") {
    throw new AppError(
      `This account is ${session.user.status}. Please contact your manager.`,
      403,
      "ACCOUNT_INACTIVE"
    );
  }

  const expiresAt = await sessionExpiresAt(session.app);
  const refresh = createRefreshToken();

  // Only succeeds if the token is still the current one, so two refreshes can't both win.
  const rotated = await prisma.session.updateMany({
    where: { id: session.id, refreshTokenHash: hash, revokedAt: null },
    data: {
      refreshTokenHash: refresh.hash,
      previousTokenHash: hash,
      lastUsedAt: new Date(),
      expiresAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 500) ?? null,
    },
  });
  if (rotated.count === 0) {
    throw new AppError(LOG_IN_AGAIN, 401, "INVALID_REFRESH_TOKEN");
  }

  return buildLoginResult(session.user, session.id, session.app, refresh.token, expiresAt, false);
}

/** An old (already swapped) refresh token was sent: treat it as stolen and end that session. */
async function endSessionIfTokenReused(hash: string): Promise<void> {
  const session = await prisma.session.findUnique({
    where: { previousTokenHash: hash },
    select: { id: true, userId: true, revokedAt: true },
  });
  if (!session || session.revokedAt) return;

  await prisma.$transaction(async (tx) => {
    const ended = await tx.session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: "token_reuse" },
    });
    if (ended.count === 0) return;
    await recordAudit(tx, {
      actorId: null,
      action: "session.revoke",
      entity: { type: "session", id: session.id },
      after: { reason: "token_reuse", userId: session.userId },
    });
  });
  logger.warn({ sessionId: session.id }, "Old refresh token used again: session ended");
}

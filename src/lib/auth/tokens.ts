import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../../config/env.js";
import type { AppType } from "../../generated/prisma/enums.js";
import { getSetting } from "../../services/settings.service.js";

/** Fixed in code: a security value, not a business setting (DEC-036). */
export const ACCESS_TOKEN_MINUTES = 15;

const ISSUER = "jp-interio-api";
const ALGORITHM = "HS256";

export interface AccessTokenClaims {
  userId: string;
  sessionId: string;
  roleId: number;
  app: AppType;
}

const payloadSchema = z.object({
  sub: z.string(),
  sid: z.string(),
  role: z.number().int(),
  app: z.enum(["web", "field", "partner"]),
});

/** A signed "day pass": who the user is, which session, role and app. Valid 15 minutes. */
export function createAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(
    { sid: claims.sessionId, role: claims.roleId, app: claims.app },
    env.AUTH_SECRET,
    {
      algorithm: ALGORITHM,
      subject: claims.userId,
      issuer: ISSUER,
      expiresIn: ACCESS_TOKEN_MINUTES * 60,
    }
  );
}

/** The token's claims, or null if it is fake, edited, expired or malformed. */
export function verifyAccessToken(token: string): AccessTokenClaims | null {
  try {
    const decoded = jwt.verify(token, env.AUTH_SECRET, {
      algorithms: [ALGORITHM],
      issuer: ISSUER,
    });
    const payload = payloadSchema.safeParse(decoded);
    if (!payload.success) return null;
    return {
      userId: payload.data.sub,
      sessionId: payload.data.sid,
      roleId: payload.data.role,
      app: payload.data.app,
    };
  } catch {
    return null;
  }
}

/**
 * Scrambles a secret value with the server secret (HMAC-SHA256, 64 hex characters).
 * The `purpose` keeps an OTP hash and a refresh-token hash from ever matching.
 */
function hashSecret(purpose: "otp" | "refresh", value: string): string {
  return createHmac("sha256", env.AUTH_SECRET).update(`${purpose}:${value}`).digest("hex");
}

/** The hash stored in otp_codes.code_hash. Tied to the phone and app it was sent for. */
export function hashOtp(phone: string, app: AppType, otp: string): string {
  return hashSecret("otp", `${phone}:${app}:${otp}`);
}

/** The hash stored in sessions.refresh_token_hash / previous_token_hash. */
export function hashRefreshToken(token: string): string {
  return hashSecret("refresh", token);
}

/** A new refresh token (the "membership card") and the hash to store. */
export function createRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashRefreshToken(token) };
}

/** Compares two hashes in constant time, so timing reveals nothing. */
export function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** When a new session ends: web 7 days, apps 60 days (from settings, DEC-032). */
export async function sessionExpiresAt(app: AppType, from = new Date()): Promise<Date> {
  const days =
    app === "web" ? await getSetting("session.web_days") : await getSetting("session.app_days");
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

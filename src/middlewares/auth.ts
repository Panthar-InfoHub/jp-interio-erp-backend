import type { Request, RequestHandler } from "express";
import { ROLES, type RoleId } from "../config/roles.js";
import type { AppType, SubAdminArea } from "../generated/prisma/enums.js";
import { verifyAccessToken } from "../lib/auth/tokens.js";
import { prisma } from "../lib/prisma.js";
import { AppError, ForbiddenError, UnauthorizedError } from "../utils/errors.js";

/** The logged-in user, put on `req.user` by `requireAuth`. Always fresh from the database. */
export interface AuthUser {
  id: string;
  sessionId: string;
  app: AppType;
  name: string | null;
  phone: string;
  roleId: RoleId;
  roleKey: string;
  /** 0 = Admin … 5 = Partner */
  tier: number;
  zoneId: string | null;
  parentId: string | null;
  /** Sub-Admins only: the areas the Admin gave them (DEC-019). Empty for everyone else. */
  subAdminAreas: SubAdminArea[];
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/** The app should call /api/auth/refresh when it sees this code. */
const tokenInvalid = () =>
  new AppError(
    "Your login has expired. Please refresh or log in again.",
    401,
    "ACCESS_TOKEN_INVALID"
  );
const sessionEnded = () =>
  new AppError("Your session has ended. Please log in again.", 401, "SESSION_ENDED");

/**
 * The guard in front of every protected route.
 * 1. Checks the access token (Authorization: Bearer …).
 * 2. Loads the session and user from the database on every request, so logout,
 *    a stolen-token end or a deactivation works immediately, not 15 minutes later.
 * 3. Puts the user on `req.user`.
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
  if (!token) throw new UnauthorizedError("Please log in.");

  const claims = verifyAccessToken(token);
  if (!claims) throw tokenInvalid();

  const session = await prisma.session.findUnique({
    where: { id: claims.sessionId },
    select: {
      userId: true,
      app: true,
      expiresAt: true,
      revokedAt: true,
      user: {
        select: {
          id: true,
          name: true,
          phone: true,
          roleId: true,
          status: true,
          zoneId: true,
          parentId: true,
          subAdminAreas: { select: { area: true } },
        },
      },
    },
  });

  if (
    !session ||
    session.revokedAt ||
    session.expiresAt.getTime() <= Date.now() ||
    session.userId !== claims.userId ||
    session.app !== claims.app
  ) {
    throw sessionEnded();
  }

  const { user } = session;
  if (user.status !== "active") {
    throw new AppError(
      `This account is ${user.status}. Please contact your manager.`,
      403,
      "ACCOUNT_INACTIVE"
    );
  }

  // The role changed since login (or no longer fits this app): log in again.
  const role = ROLES.find((r) => r.id === user.roleId);
  if (!role || user.roleId !== claims.roleId || role.app !== session.app) {
    throw sessionEnded();
  }

  req.user = {
    id: user.id,
    sessionId: claims.sessionId,
    app: session.app,
    name: user.name,
    phone: user.phone,
    roleId: role.id,
    roleKey: role.key,
    tier: role.tier,
    zoneId: user.zoneId,
    parentId: user.parentId,
    subAdminAreas: user.subAdminAreas.map((grant) => grant.area),
  };
  next();
};

/** Only these apps may use the route, e.g. `requireApp("web")`. Use after `requireAuth`. */
export function requireApp(...apps: AppType[]): RequestHandler {
  return (req, _res, next) => {
    const user = getAuthUser(req);
    if (!apps.includes(user.app)) throw new ForbiddenError();
    next();
  };
}

/** Only these roles may use the route, e.g. `requireRole(ROLE.ADMIN)`. Use after `requireAuth`. */
export function requireRole(...roleIds: RoleId[]): RequestHandler {
  return (req, _res, next) => {
    const user = getAuthUser(req);
    if (!roleIds.includes(user.roleId)) throw new ForbiddenError();
    next();
  };
}

/**
 * The logged-in user, for controllers behind `requireAuth`.
 * Throws if `requireAuth` was forgotten on the route, instead of failing silently.
 */
export function getAuthUser(req: Pick<Request, "user">): AuthUser {
  if (!req.user) throw new UnauthorizedError("Please log in.");
  return req.user;
}

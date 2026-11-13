import type { Request, RequestHandler } from "express";
import type { Capability } from "../config/capabilities.js";
import type { PermissionScope } from "../generated/prisma/enums.js";
import { logger } from "../lib/logger.js";
import { getPermissionScope } from "../services/permission.service.js";
import { ForbiddenError } from "../utils/errors.js";
import { getAuthUser } from "./auth.js";

declare global {
  namespace Express {
    interface Request {
      /** Set by `requirePermission`: on whose records the user may do the action. */
      scope?: PermissionScope;
    }
  }
}

/**
 * The permission guard (DEC-050). Use after `requireAuth`:
 *
 *   router.post("/kyc/:id/verify", requireAuth, requirePermission("kyc.verify"), ...)
 *
 * - Not allowed → 403 FORBIDDEN, and a warning in the server log.
 * - Allowed → `req.scope` is "full", "scoped" or "own" (read it with `getScope(req)`).
 *
 * It only decides IF the user may do the action. WHICH records they may touch is the
 * scope filter's job (Module 3, Task 4).
 */
export function requirePermission(capability: Capability): RequestHandler {
  return async (req, _res, next) => {
    const user = getAuthUser(req);
    const scope = await getPermissionScope(user, capability);

    if (!scope) {
      logger.warn(
        {
          userId: user.id,
          role: user.roleKey,
          subAdminAreas: user.subAdminAreas.length > 0 ? user.subAdminAreas : undefined,
          capability,
          method: req.method,
          // No query string: it could carry search text or other personal data.
          path: req.baseUrl + req.path,
        },
        "Permission refused"
      );
      throw new ForbiddenError();
    }

    req.scope = scope;
    next();
  };
}

/**
 * The scope set by `requirePermission`, for controllers and services.
 * Throws if `requirePermission` was forgotten on the route, instead of failing silently.
 */
export function getScope(req: Pick<Request, "scope">): PermissionScope {
  if (!req.scope) throw new Error("getScope() used on a route without requirePermission()");
  return req.scope;
}

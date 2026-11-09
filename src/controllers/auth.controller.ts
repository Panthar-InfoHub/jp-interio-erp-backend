import type { ValidatedRequest } from "../middlewares/validate.js";
import { getRequestContext } from "../lib/requestContext.js";
import { getAuthUser } from "../middlewares/auth.js";
import * as authService from "../services/auth.service.js";
import * as sessionService from "../services/session.service.js";
import type { idParams } from "../validators/common.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
} from "../lib/auth/refreshCookie.js";
import { AppError, UnauthorizedError } from "../utils/errors.js";
import type {
  refreshSchemas,
  requestOtpSchemas,
  verifyOtpSchemas,
} from "../validators/auth.schema.js";

/** POST /api/auth/otp/request — { phone, app } → OTP sent (never returned). */
export const requestOtp = asyncHandler<ValidatedRequest<typeof requestOtpSchemas>>(
  async (req, res) => {
    const result = await authService.requestOtp({
      phone: req.body.phone,
      app: req.body.app,
      ip: getRequestContext()?.ip,
    });
    sendSuccess(res, 200, result, "OTP sent");
  }
);

/**
 * POST /api/auth/otp/verify — { phone, app, otp, deviceId?, deviceName? } → logged in.
 * Web: the refresh token goes in the httpOnly cookie, never in the body.
 * Apps: the refresh token is in the body; the app stores it securely.
 */
export const verifyOtp = asyncHandler<ValidatedRequest<typeof verifyOtpSchemas>>(
  async (req, res) => {
    const context = getRequestContext();
    const { refreshToken, refreshExpiresAt, ...login } = await authService.verifyOtp({
      phone: req.body.phone,
      app: req.body.app,
      otp: req.body.otp,
      deviceId: req.body.deviceId,
      deviceName: req.body.deviceName,
      ip: context?.ip,
      userAgent: context?.userAgent,
    });

    if (req.body.app === "web") {
      setRefreshCookie(res, refreshToken, refreshExpiresAt);
      sendSuccess(res, 200, { ...login, refreshExpiresAt }, "Logged in");
    } else {
      sendSuccess(res, 200, { ...login, refreshToken, refreshExpiresAt }, "Logged in");
    }
  }
);

/**
 * POST /api/auth/refresh — a new access token + a new refresh token (the old one dies).
 * Apps send { refreshToken } in the body; the web console sends the jp_refresh cookie.
 * The new refresh token goes back the same way it came in.
 */
export const refresh = asyncHandler<ValidatedRequest<typeof refreshSchemas>>(async (req, res) => {
  const fromBody = req.body.refreshToken;
  const token = fromBody ?? readRefreshCookie(req);
  if (!token) throw new UnauthorizedError("Please log in again.");

  const context = getRequestContext();
  try {
    const { refreshToken, refreshExpiresAt, ...login } = await authService.refreshSession({
      refreshToken: token,
      ip: context?.ip,
      userAgent: context?.userAgent,
    });

    if (fromBody) {
      sendSuccess(res, 200, { ...login, refreshToken, refreshExpiresAt }, "Token refreshed");
    } else {
      setRefreshCookie(res, refreshToken, refreshExpiresAt);
      sendSuccess(res, 200, { ...login, refreshExpiresAt }, "Token refreshed");
    }
  } catch (error) {
    // A dead cookie is removed, so the browser stops sending it.
    if (!fromBody && error instanceof AppError && error.statusCode === 401) {
      clearRefreshCookie(res);
    }
    throw error;
  }
});

// ---- My account (all behind requireAuth) ----

/** GET /api/auth/me — who am I. */
export const me = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, await sessionService.getMe(getAuthUser(req)));
});

/** GET /api/auth/sessions — my open devices; `isCurrent` marks this one. */
export const listSessions = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, await sessionService.listSessions(getAuthUser(req)));
});

/** DELETE /api/auth/sessions/:id — log out one of my devices. */
export const revokeSession = asyncHandler<ValidatedRequest<{ params: typeof idParams }>>(
  async (req, res) => {
    const wasThisDevice = await sessionService.revokeOwnSession(getAuthUser(req), req.params.id);
    if (wasThisDevice) clearRefreshCookie(res);
    sendSuccess(res, 200, null, "Device logged out");
  }
);

/** POST /api/auth/logout — log out this device. */
export const logout = asyncHandler(async (req, res) => {
  await sessionService.logout(getAuthUser(req));
  clearRefreshCookie(res);
  sendSuccess(res, 200, null, "Logged out");
});

/** POST /api/auth/logout-all — log out every device, this one included (DEC-041). */
export const logoutAll = asyncHandler(async (req, res) => {
  const sessionsEnded = await sessionService.logoutAll(getAuthUser(req));
  clearRefreshCookie(res);
  sendSuccess(res, 200, { sessionsEnded }, "Logged out of all devices");
});

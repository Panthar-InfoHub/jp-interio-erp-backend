import type { CookieOptions, Request, Response } from "express";
import { isProd } from "../../config/env.js";

/**
 * The web console keeps its refresh token in this cookie; the mobile apps get it in
 * the reply body instead. httpOnly = page scripts can't read it; sent only to /api/auth.
 * sameSite "strict" means the web console must be on the same site as the API
 * (e.g. admin.example.com + api.example.com); see the open item in DEC-036.
 */
export const REFRESH_COOKIE = "jp_refresh";

const baseOptions: CookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: "strict",
  path: "/api/auth",
};

export function setRefreshCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, token, {
    ...baseOptions,
    maxAge: Math.max(0, expiresAt.getTime() - Date.now()),
  });
}

export function readRefreshCookie(req: Request): string | undefined {
  const value: unknown = req.cookies?.[REFRESH_COOKIE];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, baseOptions);
}

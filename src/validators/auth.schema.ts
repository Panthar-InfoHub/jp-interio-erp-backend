import { z } from "zod";
import type { RequestSchemas } from "../middlewares/validate.js";
import { phoneSchema } from "./common.js";

/** Which app the request comes from; a role may only log in to its own app. */
export const appSchema = z.enum(["web", "field", "partner"]);

export const requestOtpSchemas = {
  body: z.object({
    phone: phoneSchema,
    app: appSchema,
  }),
} satisfies RequestSchemas;

/** Optional device details from the apps; shown later in "my devices" (DEC-038). */
const deviceText = z.string().trim().min(1).max(100).optional();

export const verifyOtpSchemas = {
  body: z.object({
    phone: phoneSchema,
    app: appSchema,
    otp: z
      .string()
      .trim()
      .regex(/^\d{4,8}$/, "OTP must be digits only"),
    deviceId: deviceText,
    deviceName: deviceText,
  }),
} satisfies RequestSchemas;

/**
 * Apps send the refresh token in the body. The web console sends nothing here:
 * its token comes from the jp_refresh cookie, so the body may be missing.
 */
export const refreshSchemas = {
  body: z.object({ refreshToken: z.string().trim().min(1).max(200).optional() }).default({}),
} satisfies RequestSchemas;

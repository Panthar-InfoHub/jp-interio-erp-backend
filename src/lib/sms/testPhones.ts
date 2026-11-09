import { env, isProd } from "../../config/env.js";
import { logger } from "../logger.js";

/**
 * Test phones (DEC-035) log in with the fixed TEST_OTP and never get an SMS.
 * They work in development, and in production only when
 * ALLOW_TEST_PHONES_IN_PRODUCTION=true (e.g. during app-store review).
 */
const enabled = !isProd || env.ALLOW_TEST_PHONES_IN_PRODUCTION;
const testPhones = new Set(enabled ? env.TEST_PHONES : []);

if (isProd && testPhones.size > 0) {
  logger.warn(`Test phones are ON in production (${testPhones.size} numbers)`);
}

/** `phone` is 91XXXXXXXXXX (DEC-031). */
export function isTestPhone(phone: string): boolean {
  return testPhones.has(phone);
}

/** The fixed OTP for test phones. env.ts guarantees it is set whenever test phones exist. */
export function getTestOtp(): string {
  if (!env.TEST_OTP) throw new Error("TEST_OTP is not set");
  return env.TEST_OTP;
}

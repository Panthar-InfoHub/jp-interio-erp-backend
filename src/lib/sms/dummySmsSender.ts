import { logger } from "../logger.js";
import type { SmsSender } from "./smsSender.js";

/**
 * Development only: prints the OTP in the terminal instead of sending an SMS.
 * env.ts refuses SMS_PROVIDER=dummy in production, so this is the only place
 * an OTP is ever written to a log, and only on a developer's machine.
 */
export const dummySmsSender: SmsSender = {
  async sendOtp(phone, otp) {
    logger.warn(`[DEV SMS] OTP for ${phone} is ${otp}`);
  },
};

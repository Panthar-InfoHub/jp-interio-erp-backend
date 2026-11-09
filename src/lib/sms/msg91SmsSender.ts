import { env } from "../../config/env.js";
import { ServiceUnavailableError } from "../../utils/errors.js";
import { logger } from "../logger.js";
import type { SmsSender } from "./smsSender.js";

const FLOW_URL = "https://control.msg91.com/api/v5/flow";
const TIMEOUT_MS = 10_000;

/**
 * Sends the OTP through MSG91's Flow API (DEC-034): a DLT-approved template with
 * the OTP in the variable named by MSG91_OTP_VARIABLE. Other template variables
 * are left blank. Changing the template later is only a .env change.
 * Never logs the OTP or the auth key.
 */
export const msg91SmsSender: SmsSender = {
  async sendOtp(phone, otp) {
    let failure: string;

    try {
      const response = await fetch(FLOW_URL, {
        method: "POST",
        headers: {
          authkey: env.MSG91_AUTH_KEY ?? "",
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          template_id: env.MSG91_OTP_TEMPLATE_ID,
          short_url: "0",
          recipients: [{ mobiles: phone, [env.MSG91_OTP_VARIABLE]: otp }],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      // MSG91 answers { type: "success" | "error", message: "<request id or reason>" }.
      const result = (await response.json().catch(() => ({}))) as {
        type?: string;
        message?: string;
      };
      if (response.ok && result.type === "success") {
        logger.info({ msg91RequestId: result.message }, "OTP SMS sent");
        return;
      }
      failure = `MSG91 replied ${response.status}: ${result.message ?? "no message"}`;
    } catch (error) {
      failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }

    logger.error({ reason: failure }, "OTP SMS could not be sent");
    throw new ServiceUnavailableError("Could not send the OTP. Please try again.");
  },
};

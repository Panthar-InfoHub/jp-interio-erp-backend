import { env } from "../../config/env.js";
import { dummySmsSender } from "./dummySmsSender.js";
import { msg91SmsSender } from "./msg91SmsSender.js";
import type { SmsSender } from "./smsSender.js";

export type { SmsSender } from "./smsSender.js";

/**
 * The SMS sender chosen by SMS_PROVIDER in .env. Callers only do:
 *   await getSmsSender().sendOtp(phone, otp);
 */
export function getSmsSender(): SmsSender {
  switch (env.SMS_PROVIDER) {
    case "dummy":
      return dummySmsSender;
    case "msg91":
      return msg91SmsSender;
  }
}

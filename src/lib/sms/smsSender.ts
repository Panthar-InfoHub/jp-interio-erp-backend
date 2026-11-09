/**
 * Anything that can deliver a login OTP by SMS. The login code only uses this
 * shape, so the provider is switched in .env (SMS_PROVIDER) with no code change.
 */
export interface SmsSender {
  /** `phone` is 91XXXXXXXXXX (DEC-031). Throws if the SMS could not be sent. */
  sendOtp(phone: string, otp: string): Promise<void>;
}

import { z } from "zod";
import type { RequestSchemas } from "../middlewares/validate.js";
import { phoneSchema } from "./common.js";

/**
 * Partner onboarding steps (Module 5 T4, DEC-079 – DEC-089).
 * Number formats (PAN, Aadhaar, GST, IFSC, account, UPI) are checked in the service by
 * lib/crypto/sensitiveData.ts, so the error never repeats the number back.
 */

export const text = (label: string, max: number) =>
  z
    .string(`${label} is required`)
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be ${max} characters or fewer`);

export const optionalText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be ${max} characters or fewer`)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional();

/** Optional email, saved in small letters. Partners may share an email (DEC-088). */
export const email = z
  .union([z.literal(""), z.email("Enter a valid email address").max(255)])
  .transform((value) => (value === "" ? null : value.trim().toLowerCase()))
  .nullable()
  .optional();

/** A date like "1985-06-30", not in the future. */
export const pastDate = (label: string) =>
  z
    .union([z.literal(""), z.iso.date(`${label} must be a date like 1985-06-30`)])
    .transform((value) => (value === "" ? null : new Date(`${value}T00:00:00.000Z`)))
    .refine((value) => value === null || value.getTime() <= Date.now(), {
      message: `${label} cannot be in the future`,
    })
    .nullable()
    .optional();

const fileUrl = (label: string) => z.url(`${label}: upload the file first`).max(1000);

const secretNumber = (label: string) => z.string(`${label} is required`).min(1).max(100);

/** PUT /api/partner/onboarding/basic-info (DEC-087, DEC-088). */
export const basicInfoSchemas = {
  body: z.strictObject({
    name: text("Name", 100),
    email,
    address: text("Address", 500),
    city: text("City", 100),
    state: text("State", 100),
    pincode: z
      .string("Pincode is required")
      .trim()
      .regex(/^[1-9][0-9]{5}$/, "Pincode must be 6 digits"),
    zoneId: z.uuid("Pick a zone from the list"),
    partnerType: z.enum(["carpenter", "dealer", "oem"], "Pick carpenter, dealer or OEM"),
    /** Optional here; for a dealer / OEM it is required again as the firm name. */
    businessName: optionalText("Business name", 150),
  }),
} satisfies RequestSchemas;

/** PUT /api/partner/onboarding/firm-details — dealer / OEM only (DEC-079, DEC-080). */
export const firmDetailsSchemas = {
  body: z.strictObject({
    firmName: text("Firm name", 150),
    gstNumber: secretNumber("GST number"),
    gstCertificateUrl: fileUrl("GST certificate"),
    ownerDob: pastDate("Date of birth"),
    ownerAnniversaryDate: pastDate("Anniversary date"),
    ownerSpouseName: optionalText("Spouse's name", 100),
  }),
} satisfies RequestSchemas;

/** One bank account or UPI ID (DEC-074, DEC-076). */
export const payoutAccountBody = z.discriminatedUnion(
  "method",
  [
    z.strictObject({
      method: z.literal("bank"),
      holderName: text("Account holder's name", 150),
      accountNumber: secretNumber("Bank account number"),
      ifsc: z.string("IFSC is required").min(1).max(20),
      bankName: optionalText("Bank name", 150),
    }),
    z.strictObject({
      method: z.literal("upi"),
      upiId: secretNumber("UPI ID"),
      holderName: optionalText("Name", 150),
    }),
  ],
  "method must be bank or upi"
);

export type PayoutAccountInput = z.output<typeof payoutAccountBody>;

/** POST /api/partner/onboarding/payout-account */
export const payoutAccountSchemas = { body: payoutAccountBody } satisfies RequestSchemas;

/** PUT /api/partner/onboarding/kyc — PAN + photo, Aadhaar + one photo (DEC-081, DEC-082). */
export const kycSchemas = {
  body: z.strictObject({
    panNumber: secretNumber("PAN"),
    panPhotoUrl: fileUrl("PAN photo"),
    aadhaarNumber: secretNumber("Aadhaar"),
    aadhaarPhotoUrl: fileUrl("Aadhaar photo"),
  }),
} satisfies RequestSchemas;

// ---- Field onboarding (Module 5 T5) ----

const otp = z
  .string()
  .trim()
  .regex(/^\d{4,8}$/, "OTP must be digits only");

/** POST /api/field/onboarding/start */
export const fieldStartSchemas = {
  body: z.strictObject({ phone: phoneSchema }),
} satisfies RequestSchemas;

/** POST /api/field/onboarding/verify */
export const fieldVerifySchemas = {
  body: z.strictObject({ phone: phoneSchema, otp }),
} satisfies RequestSchemas;

const partnerParams = z.object({ partnerId: z.uuid("Invalid partner id") });

/** Field versions of the steps: the same bodies, plus the partner's id in the URL. */
export const fieldPartnerSchemas = { params: partnerParams } satisfies RequestSchemas;
export const fieldBasicInfoSchemas = {
  params: partnerParams,
  ...basicInfoSchemas,
} satisfies RequestSchemas;
export const fieldFirmDetailsSchemas = {
  params: partnerParams,
  ...firmDetailsSchemas,
} satisfies RequestSchemas;
export const fieldPayoutAccountSchemas = {
  params: partnerParams,
  ...payoutAccountSchemas,
} satisfies RequestSchemas;
export const fieldKycSchemas = { params: partnerParams, ...kycSchemas } satisfies RequestSchemas;

export type BasicInfoInput = z.output<typeof basicInfoSchemas.body>;
export type FirmDetailsInput = z.output<typeof firmDetailsSchemas.body>;
export type KycInput = z.output<typeof kycSchemas.body>;

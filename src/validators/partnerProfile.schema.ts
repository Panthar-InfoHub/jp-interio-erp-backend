import { z } from "zod";
import { idParams, phoneSchema } from "./common.js";
import { email, optionalText, pastDate, text } from "./onboarding.schema.js";

/**
 * Profile edits after verification (Module 5 T11; DEC-075, DEC-076, DEC-103).
 * Send only what changes. Not here, ever: zone (move partner), partner type,
 * phone (staff use change-phone), GST / PAN / Aadhaar.
 * The director's fields are for dealer / OEM only (checked in the service).
 */
const profileBody = z
  .strictObject({
    name: text("Name", 100).optional(),
    email,
    address: text("Address", 500).optional(),
    city: text("City", 100).optional(),
    state: text("State", 100).optional(),
    pincode: z
      .string()
      .trim()
      .regex(/^[1-9][0-9]{5}$/, "Pincode must be 6 digits")
      .optional(),
    /** Required for a dealer / OEM (it is the firm name); optional for a carpenter. */
    businessName: optionalText("Business name", 150),
    ownerDob: pastDate("Date of birth"),
    ownerAnniversaryDate: pastDate("Anniversary date"),
    ownerSpouseName: optionalText("Spouse's name", 100),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "Send at least one field to change" });

export type ProfileEditInput = z.output<typeof profileBody>;

/** PATCH /api/partner/profile */
export const editMyProfileSchemas = { body: profileBody };

/** PATCH /api/partners/:id/profile */
export const editPartnerProfileSchemas = { params: idParams, body: profileBody };

/** POST /api/partners/:id/change-phone — staff only, no OTP (DEC-074). */
export const changePhoneSchemas = {
  params: idParams,
  body: z.strictObject({ phone: phoneSchema }),
};

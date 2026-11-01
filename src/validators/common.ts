import { z } from "zod";
import { normalizePhone } from "../utils/phone.js";

/** For routes like `/partners/:id`. A malformed id is a 400, not a database error. */
export const idParams = z.object({
  id: z.uuid("Invalid id"),
});

/** An Indian mobile number in any common form, cleaned to "919876543210". */
export const phoneSchema = z.string().transform((value, ctx) => {
  const phone = normalizePhone(value);
  if (!phone) {
    ctx.addIssue({ code: "custom", message: "Enter a valid 10-digit Indian mobile number" });
    return z.NEVER;
  }
  return phone;
});

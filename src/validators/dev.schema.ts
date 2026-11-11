import { z } from "zod";
import { ROLES } from "../config/roles.js";

/** POST /api/dev/can-create — "could I add a person with this role in this zone?" (DEC-052). */
export const canCreateSchemas = {
  body: z.object({
    role: z.enum(ROLES.map((role) => role.key) as [string, ...string[]], "Unknown role"),
    zoneId: z.uuid("Invalid zone id").nullable().optional(),
  }),
};

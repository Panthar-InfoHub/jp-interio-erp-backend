import { z } from "zod";
import { listQuery } from "../utils/pagination.js";
import { idParams } from "./common.js";

/** Zone fields (DEC-020, DEC-025, DEC-060). */
const name = z.string().trim().min(1, "Name is required").max(100);

/** Saved in CAPITALS: "nz-01" → "NZ-01". Letters, digits and hyphens only. */
const code = z
  .string()
  .trim()
  .toUpperCase()
  .min(1, "Code is required")
  .max(20)
  .regex(/^[A-Z0-9-]+$/, "Code can only have letters, digits and hyphens");

/** Optional text; an empty string is saved as "not set". */
const optionalText = z
  .string()
  .trim()
  .max(100)
  .transform((value) => (value === "" ? null : value));

/** POST /api/zones */
export const createZoneSchemas = {
  body: z.object({
    name,
    code,
    region: optionalText.optional(),
    state: optionalText.optional(),
  }),
};

/** PATCH /api/zones/:id — send only what changes; null clears region/state. */
export const updateZoneSchemas = {
  params: idParams,
  body: z
    .object({
      name: name.optional(),
      code: code.optional(),
      region: optionalText.nullable().optional(),
      state: optionalText.nullable().optional(),
    })
    .refine((body) => Object.keys(body).length > 0, "Send at least one field to change"),
};

/** GET /api/zones */
export const listZonesSchemas = {
  query: listQuery({ sortFields: ["name", "code", "createdAt"], defaultSort: "name" }).extend({
    status: z.enum(["active", "inactive"]).optional(),
    /** Matches name, code, region or state (any part, any case). */
    search: z.string().trim().min(1).max(100).optional(),
  }),
};

/** GET /api/zones/:id, POST /api/zones/:id/deactivate, POST /api/zones/:id/reactivate */
export const zoneIdSchemas = { params: idParams };

/** POST /api/zones/:id/zonal-head — put this Zonal Head in charge (DEC-067). */
export const setZonalHeadSchemas = {
  params: idParams,
  body: z.object({ userId: z.uuid("Invalid user id") }),
};

export type CreateZoneInput = z.output<typeof createZoneSchemas.body>;
export type UpdateZoneInput = z.output<typeof updateZoneSchemas.body>;
export type ListZonesQuery = z.output<typeof listZonesSchemas.query>;

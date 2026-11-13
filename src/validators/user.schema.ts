import { z } from "zod";
import { SubAdminArea } from "../generated/prisma/enums.js";
import { listQuery } from "../utils/pagination.js";
import { idParams, phoneSchema } from "./common.js";

/** Staff users (Module 4; DEC-062). */

const name = z.string().trim().min(1, "Name is required").max(100);

/** Optional email, saved in small letters. An empty string means "no email". */
const email = z
  .union([z.literal(""), z.email("Enter a valid email address").max(255)])
  .transform((value) => (value === "" ? null : value.trim().toLowerCase()))
  .nullable()
  .optional();

const common = { name, phone: phoneSchema, email };

/**
 * POST /api/users — one shape per role:
 * - sub_admin:       optional `areas` (picked in the same step, DEC-062)
 * - zonal_head:      `zoneId`, or null / left out for "no zone yet" (Admin only)
 * - asm:             `zoneId` (the zone's Zonal Head becomes the manager)
 * - sales_executive: `asmId` (left out when an ASM adds one under themselves)
 */
export const createUserSchemas = {
  body: z.discriminatedUnion(
    "role",
    [
      z.object({
        role: z.literal("sub_admin"),
        ...common,
        areas: z
          .array(z.enum(SubAdminArea, "Unknown area"))
          .max(Object.keys(SubAdminArea).length)
          .transform((areas) => [...new Set(areas)])
          .default([]),
      }),
      z.object({
        role: z.literal("zonal_head"),
        ...common,
        zoneId: z.uuid("Invalid zone id").nullable().optional(),
      }),
      z.object({ role: z.literal("asm"), ...common, zoneId: z.uuid("Invalid zone id") }),
      z.object({
        role: z.literal("sales_executive"),
        ...common,
        asmId: z.uuid("Invalid ASM id").optional(),
      }),
    ],
    "Role must be one of: sub_admin, zonal_head, asm, sales_executive"
  ),
};

export type CreateUserInput = z.output<typeof createUserSchemas.body>;

const search = z.string().trim().min(1).max(100);

/** GET /api/users — the staff list (DEC-063). Everyone by default; filters narrow it. */
export const listUsersSchemas = {
  query: listQuery({ sortFields: ["name", "createdAt"], defaultSort: "name" }).extend({
    role: z
      .enum(["admin", "sub_admin", "zonal_head", "asm", "sales_executive"], "Unknown role")
      .optional(),
    zoneId: z.uuid("Invalid zone id").optional(),
    status: z.enum(["active", "suspended", "deactivated"], "Unknown status").optional(),
    /** Everyone directly under this manager. */
    managerId: z.uuid("Invalid manager id").optional(),
    /** Part of the name, phone or email (any case). */
    search: search.optional(),
  }),
};

/** GET /api/users/picker — active Zonal Heads, ASMs and Sales Executives only (DEC-063). */
export const pickerSchemas = {
  query: listQuery({ sortFields: ["name"], defaultSort: "name" }).extend({
    role: z.enum(["zonal_head", "asm", "sales_executive"], "Unknown role").optional(),
    zoneId: z.uuid("Invalid zone id").optional(),
    /** Part of the name (any case). */
    search: search.optional(),
  }),
};

/** GET /api/users/:id */
export const userIdSchemas = { params: idParams };

const atLeastOne = (body: object) => Object.keys(body).length > 0;
const atLeastOneMessage = "Send at least one field to change";

/** PATCH /api/users/:id — a manager edits name, phone, email (DEC-064). Null/"" clears email. */
export const updateUserSchemas = {
  params: idParams,
  body: z
    .object({ name: name.optional(), phone: phoneSchema.optional(), email })
    .refine(atLeastOne, atLeastOneMessage),
};

/** PATCH /api/users/me — my own name and email only; never the phone (DEC-064). */
export const updateMeSchemas = {
  body: z.strictObject({ name: name.optional(), email }).refine(atLeastOne, atLeastOneMessage),
};

/**
 * POST /api/users/:id/transfer (DEC-066). Exactly one of:
 * - `asmId`: move a Sales Executive to another ASM
 * - `zoneId`: move an ASM to another zone (Admin only)
 */
export const transferUserSchemas = {
  params: idParams,
  body: z
    .object({
      asmId: z.uuid("Invalid ASM id").optional(),
      zoneId: z.uuid("Invalid zone id").optional(),
    })
    .refine(
      (body) => (body.asmId === undefined) !== (body.zoneId === undefined),
      "Send either asmId (to move a Sales Executive) or zoneId (to move an ASM), not both"
    ),
};

export type UpdateUserInput = z.output<typeof updateUserSchemas.body>;
export type TransferUserInput = z.output<typeof transferUserSchemas.body>;
export type UpdateMeInput = z.output<typeof updateMeSchemas.body>;

export type ListUsersQuery = z.output<typeof listUsersSchemas.query>;
export type PickerQuery = z.output<typeof pickerSchemas.query>;

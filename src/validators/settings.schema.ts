import { z } from "zod";

/** PATCH /api/settings/:key — { value }. The value is checked against the setting's type and limits in the service. */
export const updateSettingSchemas = {
  params: z.object({ key: z.string().min(1).max(100) }),
  body: z.object({
    value: z.unknown().refine((value) => value !== undefined, "value is required"),
  }),
};

import { z } from "zod";
import { SubAdminArea } from "../generated/prisma/enums.js";
import { idParams } from "./common.js";

/** PUT /api/sub-admins/:id/areas — the full list of areas (DEC-053). Empty is allowed. */
export const setAreasSchemas = {
  params: idParams,
  body: z.object({
    areas: z
      .array(z.enum(SubAdminArea, "Unknown area"))
      .max(Object.keys(SubAdminArea).length)
      // The same area twice is harmless: keep it once.
      .transform((areas) => [...new Set(areas)]),
  }),
};

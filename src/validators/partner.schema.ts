import { z } from "zod";
import { idParams } from "./common.js";

/** Partners. Module 4 Task 9 (DEC-069); Module 5 adds the rest. */

/** POST /api/partners/:id/assign-sales-executive */
export const assignSalesExecutiveSchemas = {
  params: idParams,
  body: z.object({ salesExecutiveId: z.uuid("Invalid Sales Executive id") }),
};

/** POST /api/partners/:id/unassign-sales-executive (no body) */
export const partnerIdSchemas = { params: idParams };

/** POST /api/partners/:id/transfer */
export const transferPartnerSchemas = {
  params: idParams,
  body: z.object({ asmId: z.uuid("Invalid ASM id") }),
};

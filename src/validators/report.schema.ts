import { z } from "zod";
import {
  KycState,
  PartnerType,
  PayoutStatus,
  RequestCategory,
  RequestStatus,
  TaskStatus,
} from "../generated/prisma/enums.js";

// ---------------------------------------------------------------------------
// Module 16 T5: CSV reports (DEC-224). Every report: optional India dates `from` / `to`
// (empty = this month; partners: no default, "joined between") and `zoneId`.
// ---------------------------------------------------------------------------

/** The 8 CSV reports (DEC-213); also their download addresses `/reports/<key>.csv`. */
export const REPORT_KEYS = [
  "scans",
  "points-issued",
  "payouts",
  "partners",
  "products",
  "regions",
  "tasks",
  "requests",
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

const isoDay = (name: string) =>
  z.iso.date({ message: `${name} must be a date like 2026-11-01` }).optional();

const enumOf = <const T extends Record<string, string>>(values: T, name: string) =>
  z
    .enum(values, { message: `${name} must be one of: ${Object.values(values).join(", ")}` })
    .optional();

const common = {
  from: isoDay("from"),
  to: isoDay("to"),
  zoneId: z.uuid("zoneId must be a valid id").optional(),
};

/** Adds the report filters to the common ones, and refuses `from` after `to`. */
function withDateOrder<T extends z.ZodRawShape>(shape: T) {
  return z.object({ ...common, ...shape }).superRefine((query, ctx) => {
    const { from, to } = query as { from?: string; to?: string };
    if (from && to && from > to) {
      ctx.addIssue({ code: "custom", message: "from must be on or before to", path: ["from"] });
    }
  });
}

/** Partner activity filter on the partners report (DEC-201, DEC-224). */
export const PARTNER_ACTIVITY = ["active", "dormant", "suspended"] as const;

export const reportQuerySchemas = {
  scans: withDateOrder({
    productId: z.uuid("productId must be a valid id").optional(),
    partnerId: z.uuid("partnerId must be a valid id").optional(),
  }),
  "points-issued": withDateOrder({}),
  payouts: withDateOrder({ status: enumOf(PayoutStatus, "status") }),
  partners: withDateOrder({
    kycState: enumOf(KycState, "kycState"),
    activity: z
      .enum(PARTNER_ACTIVITY, {
        message: `activity must be one of: ${PARTNER_ACTIVITY.join(", ")}`,
      })
      .optional(),
    partnerType: enumOf(PartnerType, "partnerType"),
  }),
  products: withDateOrder({}),
  regions: withDateOrder({}),
  tasks: withDateOrder({ status: enumOf(TaskStatus, "status") }),
  requests: withDateOrder({
    stage: enumOf(RequestStatus, "stage"),
    type: enumOf(RequestCategory, "type"),
  }),
} satisfies Record<ReportKey, z.ZodType>;

export type ReportQuery = {
  [K in ReportKey]: z.output<(typeof reportQuerySchemas)[K]>;
};

/** GET /api/reports/points-liability (Module 8 T7, DEC-136). No `asOf` = now. */
export const pointsLiabilitySchemas = {
  query: z.object({
    asOf: z.iso
      .datetime({
        offset: true,
        message: "asOf must be a date-time like 2026-11-30T23:59:59+05:30",
      })
      .transform((value) => new Date(value))
      .optional(),
  }),
};

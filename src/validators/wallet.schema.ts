import { z } from "zod";
import { listQuery } from "../utils/pagination.js";
import { idParams } from "./common.js";

const ENTRY_TYPES = ["earn", "hold", "release", "redeem", "refund", "adjust"] as const;

/** A moment like "2026-11-19T00:00:00+05:30"; the screen sends its own day start / end. */
const moment = (label: string) =>
  z.iso
    .datetime({
      offset: true,
      message: `${label} must be a date-time like 2026-11-19T00:00:00+05:30`,
    })
    .transform((value) => new Date(value));

/** `?type=earn` or several at once: `?type=hold,release,redeem,refund`. */
const typeList = z
  .string()
  .trim()
  .min(1)
  .transform((value) => [...new Set(value.split(",").map((part) => part.trim()))])
  .pipe(
    z.array(
      z.enum(ENTRY_TYPES, {
        message: `type must be one or more of: ${ENTRY_TYPES.join(", ")} (comma-separated)`,
      })
    )
  );

/** Statement filters (DEC-133). Newest first by default. */
const statementFields = listQuery({
  sortFields: ["createdAt"],
  defaultSort: "-createdAt",
}).extend({
  type: typeList.optional(),
  /** Points in (credit) or out (debit). */
  direction: z.enum(["credit", "debit"]).optional(),
  /** At or after this moment. */
  from: moment("from").optional(),
  /** At or before this moment. */
  to: moment("to").optional(),
});

const datesInOrder = (query: { from?: Date; to?: Date }) =>
  !query.from || !query.to || query.from <= query.to;
const datesMessage = { message: "from must be before to", path: ["to"] };

export const statementQuery = statementFields.refine(datesInOrder, datesMessage);
export type StatementQuery = z.output<typeof statementQuery>;

/** GET /api/partner/wallet/statement (T4) */
export const myStatementSchemas = { query: statementQuery };

/** GET /api/partners/:id/wallet (T5) */
export const partnerWalletSchemas = { params: idParams };

/** GET /api/partners/:id/ledger (T5): same filters as the partner's own statement. */
export const partnerLedgerSchemas = { params: idParams, query: statementQuery };

/** GET /api/ledger (T5, DEC-134): the statement filters plus who / where. */
export const ledgerQuery = statementFields
  .extend({
    zoneId: z.uuid("Invalid zone id").optional(),
    asmId: z.uuid("Invalid ASM id").optional(),
    partnerId: z.uuid("Invalid partner id").optional(),
    /** Part of the partner's name, business name or phone. */
    search: z.string().trim().min(1).max(100).optional(),
    /** Lines made by this staff member (e.g. to check their adjustments). */
    createdById: z.uuid("Invalid staff id").optional(),
  })
  .refine(datesInOrder, datesMessage);
export type LedgerQuery = z.output<typeof ledgerQuery>;

export const ledgerSchemas = { query: ledgerQuery };

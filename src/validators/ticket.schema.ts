import { z } from "zod";
import { TICKET_CATEGORY_CODES } from "../config/ticketCategories.js";
import { listQuery } from "../utils/pagination.js";
import { idParams } from "./common.js";

/**
 * Support tickets (Module 15; DEC-187 – DEC-192). Limits match the `support_tickets` table:
 * description 10 – 2,000 characters, 0 – 5 photos (DEC-188).
 */
export const TICKET_DESCRIPTION_MIN = 10;
export const TICKET_DESCRIPTION_MAX = 2000;
export const TICKET_PHOTOS_MAX = 5;

export const TICKET_STATUSES = ["open", "in_progress", "resolved", "rejected"] as const;

export const ticketStatus = z.enum(TICKET_STATUSES, {
  message: `status must be one of: ${TICKET_STATUSES.join(", ")}`,
});

export const ticketCategory = z.enum(TICKET_CATEGORY_CODES, {
  message: `category must be one of: ${TICKET_CATEGORY_CODES.join(", ")}`,
});

/**
 * POST /api/partner/tickets (T2) — any partner except suspended (DEC-189).
 * - `category`: one of the codes from GET /api/partner/tickets/categories.
 * - `description`: 10 – 2,000 characters (DEC-188).
 * - `photoUrls`: optional, 0 – 5 `fileUrl`s from upload links with purpose `ticket_photo`, no
 *   repeats (DEC-192). Each one is checked by the server (ours, theirs, a real image, 5 MB).
 */
export const createTicketSchemas = {
  body: z.object({
    category: ticketCategory,
    description: z
      .string({ message: "description is required" })
      .trim()
      .min(
        TICKET_DESCRIPTION_MIN,
        `description must be at least ${TICKET_DESCRIPTION_MIN} characters`
      )
      .max(
        TICKET_DESCRIPTION_MAX,
        `description can be at most ${TICKET_DESCRIPTION_MAX} characters`
      ),
    photoUrls: z
      .array(z.url("Each photo must be the fileUrl from the upload link").max(1000), {
        message: "photoUrls must be a list",
      })
      .max(TICKET_PHOTOS_MAX, `At most ${TICKET_PHOTOS_MAX} photos`)
      .refine((urls) => new Set(urls).size === urls.length, {
        message: "The same photo is in the list twice",
      })
      .default([]),
  }),
};
export type CreateTicketInput = z.output<typeof createTicketSchemas.body>;

/** GET /api/partner/tickets/:id. */
export const ticketIdSchemas = { params: idParams };

/** GET /api/partner/tickets — my tickets, newest first, optional status filter (DEC-192). */
export const myTicketsSchemas = {
  query: listQuery({ sortFields: ["createdAt"], defaultSort: "-createdAt" }).extend({
    status: ticketStatus.optional(),
  }),
};
export type MyTicketsQuery = z.output<typeof myTicketsSchemas.query>;

// ---- T3: the Admin side (DEC-193) ----

/**
 * GET /api/tickets — the Admin queue, newest first.
 * - `status`: `unfinished` (default: open + in progress), `all`, or one status.
 * - `category`: one category code.
 * - `search`: part of the ticket number, the partner's name or phone.
 */
export const TICKET_QUEUE_VIEWS = ["unfinished", "all", ...TICKET_STATUSES] as const;

export const ticketQueueSchemas = {
  query: listQuery({ sortFields: ["createdAt"], defaultSort: "-createdAt" }).extend({
    status: z
      .enum(TICKET_QUEUE_VIEWS, {
        message: `status must be one of: ${TICKET_QUEUE_VIEWS.join(", ")}`,
      })
      .default("unfinished"),
    category: ticketCategory.optional(),
    search: z.string().trim().min(1).max(100).optional(),
    /** One partner's tickets (Partner 360 Tickets tab, DEC-295). */
    partnerId: z.uuid("Invalid partnerId").optional(),
  }),
};
export type TicketQueueQuery = z.output<typeof ticketQueueSchemas.query>;

export const TICKET_NOTE_MIN = 10;
export const TICKET_NOTE_MAX = 2000;

/**
 * POST /api/tickets/:id/status (DEC-188, DEC-193).
 * - `in_progress`: no note (a note is refused).
 * - `resolved` / `rejected`: `note` required, 10 – 2,000 characters.
 * - Going back to `open` is not possible (not in the list).
 */
export const changeTicketStatusSchemas = {
  params: idParams,
  body: z
    .object({
      status: z.enum(["in_progress", "resolved", "rejected"], {
        message: "status must be in_progress, resolved or rejected",
      }),
      note: z.string({ message: "note must be text" }).trim().optional(),
    })
    .superRefine((body, ctx) => {
      if (body.status === "in_progress") {
        if (body.note) {
          ctx.addIssue({
            code: "custom",
            path: ["note"],
            message: "No note when moving to in_progress; add it when resolving or rejecting",
          });
        }
        return;
      }
      const length = body.note?.length ?? 0;
      if (length < TICKET_NOTE_MIN) {
        ctx.addIssue({
          code: "custom",
          path: ["note"],
          message: `note must be at least ${TICKET_NOTE_MIN} characters`,
        });
      } else if (length > TICKET_NOTE_MAX) {
        ctx.addIssue({
          code: "custom",
          path: ["note"],
          message: `note can be at most ${TICKET_NOTE_MAX} characters`,
        });
      }
    })
    .transform((body) => ({
      status: body.status,
      note: body.status === "in_progress" ? null : (body.note ?? null),
    })),
};
export type ChangeTicketStatusInput = z.output<typeof changeTicketStatusSchemas.body>;

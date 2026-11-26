import { getAuthUser } from "../middlewares/auth.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import * as ticketService from "../services/ticket.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import type {
  changeTicketStatusSchemas,
  createTicketSchemas,
  myTicketsSchemas,
  ticketIdSchemas,
  ticketQueueSchemas,
} from "../validators/ticket.schema.js";

// ---------------------------------------------------------------------------
// T2: the partner side — /api/partner/tickets (DEC-192)
// ---------------------------------------------------------------------------

/**
 * GET /api/partner/tickets/categories (partner) and GET /api/tickets/categories (Admin,
 * DEC-295) — codes and display names.
 */
export const categories = asyncHandler(async (_req, res) => {
  sendSuccess(res, 200, ticketService.listCategories());
});

/** POST /api/partner/tickets — raise a ticket (0 – 5 photos). */
export const createMine = asyncHandler<ValidatedRequest<typeof createTicketSchemas>>(
  async (req, res) => {
    const ticket = await ticketService.createTicket(getAuthUser(req), req.body);
    sendSuccess(res, 201, ticket, `Ticket ${ticket.ticketNo} raised`);
  }
);

/** GET /api/partner/tickets — my tickets, newest first. */
export const listMine = asyncHandler<ValidatedRequest<typeof myTicketsSchemas>>(
  async (req, res) => {
    const { items, meta } = await ticketService.listMyTickets(getAuthUser(req).id, req.query);
    sendSuccess(res, 200, items, undefined, meta);
  }
);

/** GET /api/partner/tickets/:id — one own ticket. */
export const getMine = asyncHandler<ValidatedRequest<typeof ticketIdSchemas>>(async (req, res) => {
  sendSuccess(res, 200, await ticketService.getMyTicket(getAuthUser(req).id, req.params.id));
});

// ---------------------------------------------------------------------------
// T3: the Admin side — /api/tickets, `tickets.handle`, web console (DEC-193)
// ---------------------------------------------------------------------------

/** GET /api/tickets — the queue (unfinished by default) with counts per status. */
export const queue = asyncHandler<ValidatedRequest<typeof ticketQueueSchemas>>(async (req, res) => {
  const { counts, items, meta } = await ticketService.listTicketQueue(req.query);
  sendSuccess(res, 200, { counts, items }, undefined, meta);
});

/** GET /api/tickets/:id — full ticket with the partner and who last changed it. */
export const detail = asyncHandler<ValidatedRequest<typeof ticketIdSchemas>>(async (req, res) => {
  sendSuccess(res, 200, await ticketService.getTicket(req.params.id));
});

const STATUS_MESSAGES = {
  in_progress: "Ticket marked in progress",
  resolved: "Ticket resolved",
  rejected: "Ticket rejected",
} as const;

/** POST /api/tickets/:id/status — move the ticket; note required to resolve / reject. */
export const changeStatus = asyncHandler<ValidatedRequest<typeof changeTicketStatusSchemas>>(
  async (req, res) => {
    const result = await ticketService.changeTicketStatus(
      getAuthUser(req),
      req.params.id,
      req.body
    );
    sendSuccess(
      res,
      200,
      result,
      result.alreadyDone
        ? `This ticket is already ${req.body.status.replace("_", " ")}`
        : STATUS_MESSAGES[req.body.status]
    );
  }
);

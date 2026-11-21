import { TICKET_CATEGORIES, ticketCategoryLabel } from "../config/ticketCategories.js";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";
import { pageMeta, toPrismaOrderBy, toPrismaPaging } from "../utils/pagination.js";
import type {
  ChangeTicketStatusInput,
  CreateTicketInput,
  MyTicketsQuery,
  TicketQueueQuery,
} from "../validators/ticket.schema.js";
import { recordAudit } from "./audit.service.js";
import { getPermissionScope } from "./permission.service.js";
import { verifyUploadedFile } from "./storage.service.js";

/**
 * Support tickets (Module 15; DEC-187 – DEC-192). Every change to a ticket goes through this
 * file.
 *
 * - Raise (T2): any partner except suspended (they can't log in, DEC-189); 0 – 5 checked
 *   photos stored as a list of links (DEC-191); number `TKT-<year>-<0001>` under a lock.
 * - The partner only raises: no edit, cancel, close or reopen (DEC-187).
 * - Only the Admin handles tickets (T3, DEC-020). No conversation, no "assign to", no SLA.
 * - Every change writes an audit row in the same transaction (rule R4). Nothing is deleted.
 */

// ---------------------------------------------------------------------------
// Ticket numbers (DEC-189): `TKT-<UTC year>-<4 digits>`, restarting at 1 each year.
// ---------------------------------------------------------------------------

export function formatTicketNo(year: number, seq: number): string {
  return `TKT-${year}-${String(seq).padStart(4, "0")}`;
}

/** One lock for ticket numbers, so two tickets raised at the same moment never share one. */
async function nextTicketNumber(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"support:ticket_no"}::text, 0))`;
  const year = new Date().getUTCFullYear();
  const last = await tx.supportTicket.aggregate({ where: { year }, _max: { seq: true } });
  const seq = (last._max.seq ?? 0) + 1;
  return { year, seq, ticketNo: formatTicketNo(year, seq) };
}

// ---------------------------------------------------------------------------
// Shape sent to the Partner App. Never shows which Admin changed it (DEC-192).
// ---------------------------------------------------------------------------

const PARTNER_TICKET_SELECT = {
  id: true,
  ticketNo: true,
  category: true,
  description: true,
  photoUrls: true,
  status: true,
  resolutionNote: true,
  statusChangedAt: true,
  closedAt: true,
  createdAt: true,
} satisfies Prisma.SupportTicketSelect;

type PartnerTicketRow = Prisma.SupportTicketGetPayload<{ select: typeof PARTNER_TICKET_SELECT }>;

function toPartnerTicket(row: PartnerTicketRow) {
  return {
    ...row,
    categoryLabel: ticketCategoryLabel(row.category),
    photoUrls: row.photoUrls ?? [],
  };
}

/** List rows: no long description, no photo links (count only). */
function toPartnerTicketListItem({ description: _d, photoUrls, ...row }: PartnerTicketRow) {
  return {
    ...row,
    categoryLabel: ticketCategoryLabel(row.category),
    photoCount: photoUrls?.length ?? 0,
  };
}

// ---------------------------------------------------------------------------
// T2: the partner side (DEC-192)
// ---------------------------------------------------------------------------

/** GET /api/partner/tickets/categories — codes and display names (DEC-192). */
export function listCategories() {
  return TICKET_CATEGORIES.map(({ code, label }) => ({ code, label }));
}

/**
 * POST /api/partner/tickets — raise a ticket. Photos are checked in storage before the
 * transaction (as for task photos). No `Idempotency-Key` (DEC-190): a double tap can make two
 * tickets; the Admin rejects the duplicate.
 */
export async function createTicket(me: AuthUser, input: CreateTicketInput) {
  for (const [index, url] of input.photoUrls.entries()) {
    await verifyUploadedFile(me, "ticket_photo", url, `photo ${index + 1}`);
  }

  return prisma.$transaction(async (tx) => {
    const { year, seq, ticketNo } = await nextTicketNumber(tx);
    const ticket = await tx.supportTicket.create({
      data: {
        ticketNo,
        year,
        seq,
        partnerId: me.id,
        category: input.category,
        description: input.description,
        photoUrls: input.photoUrls,
      },
      select: PARTNER_TICKET_SELECT,
    });
    await recordAudit(tx, {
      actorId: me.id,
      action: "ticket.create",
      entity: { type: "support_ticket", id: ticket.id },
      after: {
        ticketNo,
        category: input.category,
        status: ticket.status,
        photoCount: input.photoUrls.length,
      },
    });
    return toPartnerTicket(ticket);
  });
}

/** GET /api/partner/tickets — my tickets, newest first, optional status filter. */
export async function listMyTickets(
  partnerId: string,
  query: MyTicketsQuery,
  db: Prisma.TransactionClient = prisma
) {
  const where: Prisma.SupportTicketWhereInput = {
    partnerId,
    ...(query.status && { status: query.status }),
  };
  const [rows, total] = await Promise.all([
    db.supportTicket.findMany({
      where,
      orderBy: toPrismaOrderBy(query.sort),
      ...toPrismaPaging(query.page, query.limit),
      select: PARTNER_TICKET_SELECT,
    }),
    db.supportTicket.count({ where }),
  ]);
  return {
    items: rows.map(toPartnerTicketListItem),
    meta: pageMeta(query.page, query.limit, total),
  };
}

/** GET /api/partner/tickets/:id — one own ticket; someone else's → 404. */
export async function getMyTicket(
  partnerId: string,
  ticketId: string,
  db: Prisma.TransactionClient = prisma
) {
  const row = await db.supportTicket.findFirst({
    where: { id: ticketId, partnerId },
    select: PARTNER_TICKET_SELECT,
  });
  if (!row) throw new NotFoundError("Ticket not found");
  return toPartnerTicket(row);
}

// ---------------------------------------------------------------------------
// T3: the Admin side (DEC-193). Only the Admin has `tickets.handle` (DEC-020): no scope
// filter is needed beyond the permission, every ticket is in reach.
// ---------------------------------------------------------------------------

const UNFINISHED: Prisma.SupportTicketWhereInput = { status: { in: ["open", "in_progress"] } };
const FINAL_STATUSES = ["resolved", "rejected"] as const;

const ADMIN_PARTNER_SELECT = {
  select: {
    id: true,
    name: true,
    phone: true,
    status: true,
    zone: { select: { id: true, name: true, code: true } },
    partnerProfile: { select: { partnerType: true, businessName: true, kycState: true } },
  },
} as const;

const ADMIN_TICKET_SELECT = {
  ...PARTNER_TICKET_SELECT,
  partner: ADMIN_PARTNER_SELECT,
  updatedBy: { select: { id: true, name: true } },
  updatedAt: true,
} satisfies Prisma.SupportTicketSelect;

type AdminTicketRow = Prisma.SupportTicketGetPayload<{ select: typeof ADMIN_TICKET_SELECT }>;

function toAdminTicket({ partner, ...row }: AdminTicketRow) {
  const { partnerProfile, ...person } = partner;
  return {
    ...row,
    categoryLabel: ticketCategoryLabel(row.category),
    photoUrls: row.photoUrls ?? [],
    partner: {
      ...person,
      partnerType: partnerProfile?.partnerType ?? null,
      businessName: partnerProfile?.businessName ?? null,
      kycState: partnerProfile?.kycState ?? null,
    },
  };
}

function toAdminTicketListItem(row: AdminTicketRow) {
  const { description: _d, photoUrls, ...ticket } = toAdminTicket(row);
  return { ...ticket, photoCount: photoUrls.length };
}

function queueWhere(query: TicketQueueQuery): Prisma.SupportTicketWhereInput {
  const statusWhere: Prisma.SupportTicketWhereInput =
    query.status === "unfinished"
      ? UNFINISHED
      : query.status === "all"
        ? {}
        : { status: query.status };
  return {
    AND: [
      statusWhere,
      ...(query.category ? [{ category: query.category }] : []),
      ...(query.search
        ? [
            {
              OR: [
                { ticketNo: { contains: query.search, mode: "insensitive" as const } },
                { partner: { name: { contains: query.search, mode: "insensitive" as const } } },
                { partner: { phone: { contains: query.search } } },
              ],
            },
          ]
        : []),
    ],
  };
}

/** Counts per status for badges, over every ticket (not affected by the filters). */
async function statusCounts(db: Prisma.TransactionClient = prisma) {
  const rows = await db.supportTicket.groupBy({ by: ["status"], _count: { _all: true } });
  const counts = { open: 0, in_progress: 0, resolved: 0, rejected: 0 };
  for (const row of rows) counts[row.status] = row._count._all;
  return { ...counts, unfinished: counts.open + counts.in_progress };
}

/** GET /api/tickets — the Admin queue: unfinished by default, newest first, with counts. */
export async function listTicketQueue(
  query: TicketQueueQuery,
  db: Prisma.TransactionClient = prisma
) {
  const where = queueWhere(query);
  const [rows, total, counts] = await Promise.all([
    db.supportTicket.findMany({
      where,
      orderBy: toPrismaOrderBy(query.sort),
      ...toPrismaPaging(query.page, query.limit),
      select: ADMIN_TICKET_SELECT,
    }),
    db.supportTicket.count({ where }),
    statusCounts(db),
  ]);
  return {
    counts,
    items: rows.map(toAdminTicketListItem),
    meta: pageMeta(query.page, query.limit, total),
  };
}

/** GET /api/tickets/:id — full ticket with photos, the partner and who last changed it. */
export async function getTicket(ticketId: string, db: Prisma.TransactionClient = prisma) {
  const row = await db.supportTicket.findUnique({
    where: { id: ticketId },
    select: ADMIN_TICKET_SELECT,
  });
  if (!row) throw new NotFoundError("Ticket not found");
  return toAdminTicket(row);
}

/** Allowed moves (DEC-188): open → in_progress / resolved / rejected; in_progress → resolved / rejected. */
function moveAllowed(from: string, to: string) {
  if (from === "open") return true;
  if (from === "in_progress") return to === "resolved" || to === "rejected";
  return false;
}

/**
 * POST /api/tickets/:id/status — the Admin moves the ticket (DEC-188, DEC-193).
 * - The same status again → no change (`alreadyDone`), e.g. a double click; the first note stays.
 * - A resolved / rejected ticket can't change → 409. No going back to open.
 * - Saves who changed it and when; resolve / reject also save the note and `closedAt`.
 */
export async function changeTicketStatusInTx(
  tx: Prisma.TransactionClient,
  me: AuthUser,
  ticketId: string,
  input: ChangeTicketStatusInput
) {
  const locked = await tx.$queryRaw<{ id: string; status: string }[]>`
    SELECT id, status::text AS status FROM support_tickets WHERE id = ${ticketId}::uuid FOR UPDATE`;
  const current = locked[0];
  if (!current) throw new NotFoundError("Ticket not found");

  if (current.status === input.status) {
    return { alreadyDone: true, ticket: await getTicket(ticketId, tx) };
  }
  if (!moveAllowed(current.status, input.status)) {
    throw new ConflictError(
      (FINAL_STATUSES as readonly string[]).includes(current.status)
        ? `This ticket is already ${current.status} and can't be changed.`
        : `A ticket can't move from ${current.status} to ${input.status}.`
    );
  }

  const now = new Date();
  const isFinal = input.status === "resolved" || input.status === "rejected";
  await tx.supportTicket.update({
    where: { id: ticketId },
    data: {
      status: input.status,
      updatedById: me.id,
      statusChangedAt: now,
      ...(isFinal && { resolutionNote: input.note, closedAt: now }),
    },
  });
  await recordAudit(tx, {
    actorId: me.id,
    action: `ticket.${input.status === "in_progress" ? "start" : input.status === "resolved" ? "resolve" : "reject"}`,
    entity: { type: "support_ticket", id: ticketId },
    before: { status: current.status },
    after: { status: input.status, ...(isFinal && { resolutionNote: input.note }) },
  });
  return { alreadyDone: false, ticket: await getTicket(ticketId, tx) };
}

export async function changeTicketStatus(
  me: AuthUser,
  ticketId: string,
  input: ChangeTicketStatusInput
) {
  return prisma.$transaction((tx) => changeTicketStatusInTx(tx, me, ticketId, input));
}

/**
 * Partner 360 `tickets` box (DEC-190): counts per status. Only for staff with
 * `tickets.handle` (the Admin); everyone else gets nothing (the box is left out).
 */
export async function ticketsBoxFor360(
  me: AuthUser,
  partnerId: string,
  db: Prisma.TransactionClient = prisma
) {
  if (!(await getPermissionScope(me, "tickets.handle"))) return undefined;
  const rows = await db.supportTicket.groupBy({
    by: ["status"],
    where: { partnerId },
    _count: { _all: true },
  });
  const counts = { open: 0, in_progress: 0, resolved: 0, rejected: 0 };
  for (const row of rows) counts[row.status] = row._count._all;
  return { ...counts, total: counts.open + counts.in_progress + counts.resolved + counts.rejected };
}

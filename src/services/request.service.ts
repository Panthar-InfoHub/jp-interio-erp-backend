import { ROLE } from "../config/roles.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { PermissionScope, RequestStatus } from "../generated/prisma/enums.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { AppError, NotFoundError, ValidationError } from "../utils/errors.js";
import { dateFromIso, isoFromDate } from "../utils/istDate.js";
import { pageMeta, toPrismaOrderBy, toPrismaPaging } from "../utils/pagination.js";
import type {
  AllRequestsQuery,
  AssignRequestInput,
  TakeBackRequestInput,
  AcceptRequestInput,
  CancelRequestInput,
  CreateRequestInput,
  MoneyStepInput,
  MyRequestsQuery,
  PartnerRequestsQuery,
  RejectRequestInput,
  WorklistQuery,
} from "../validators/request.schema.js";
import { recordAudit } from "./audit.service.js";
import { getPermissionScope } from "./permission.service.js";
import { assertProductUsable } from "./product.service.js";
import { assertInScope, scopeForPartners, scopeForRequests } from "./scope.service.js";
import { verifyUploadedFile } from "./storage.service.js";

/**
 * Requests (Module 11; DEC-157 – DEC-169). "Leads" are the same thing (DEC-157).
 *
 * Shipment: requested → accepted → payment_received → processing → dispatched → delivered →
 * completed. Sample (free): the same without payment_received. requested → rejected.
 * accepted / payment_received / processing → cancelled; cancelled after payment →
 * refund_initiated → refunded. Every move is permanent: no skipping, no going back (DEC-162).
 *
 * No reward points are involved: the ledger is never touched. Every change writes a
 * timeline row (`partner_request_events`, DEC-166) and an audit entry in the same transaction.
 */

/** Steps on one partner's requests wait in line; allow a little longer than the default. */
const REQUEST_TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;

/** Same `Idempotency-Key` sent again with other details (DEC-169, same rule as DEC-153). */
export class RequestKeyReusedError extends AppError {
  constructor() {
    super(
      "This Idempotency-Key was already used for a different request. Make a new key for a new request.",
      409,
      "IDEMPOTENCY_KEY_REUSED"
    );
  }
}

/** A step that the request's stage doesn't allow (e.g. cancelling a dispatched request). */
export class RequestStatusError extends AppError {
  constructor(status: RequestStatus, action: string, message?: string) {
    super(
      message ?? `This request is ${status}, so it can't be ${action}.`,
      409,
      "REQUEST_WRONG_STATUS",
      { status }
    );
  }
}

// ---------------------------------------------------------------------------
// Stage rules shared by the partner (T3) and the handler (T4)
// ---------------------------------------------------------------------------

/** Stages a request can be cancelled from: anything before Dispatched (DEC-161). */
export const CANCELLABLE_STATUSES: readonly RequestStatus[] = [
  "requested",
  "accepted",
  "payment_received",
  "processing",
];

/**
 * "Open" requests (DEC-165): not at an end stage. A cancelled request whose money was
 * received stays open until it is refunded. Used to block partner transfers and Sales
 * Executive changes (T5) and the later suspend feature (DEC-163).
 */
export const OPEN_REQUEST_WHERE: Prisma.PartnerRequestWhereInput = {
  OR: [
    {
      status: {
        in: [
          "requested",
          "accepted",
          "payment_received",
          "processing",
          "dispatched",
          "delivered",
          "refund_initiated",
        ],
      },
    },
    { status: "cancelled", paymentDate: { not: null } },
  ],
};

/** 409 for a people change that open requests block (DEC-165, DEC-172). */
export class OpenRequestsError extends AppError {
  constructor(message: string, openRequests: number) {
    super(message, 409, "OPEN_REQUESTS", { openRequests });
  }
}

/**
 * Open requests of one partner (DEC-165), inside the caller's transaction. Locks the
 * partner's user row, then their profile row — the same rows, in the same order, as a new
 * request (T3) — so a request can't slip in between this count and the caller's change,
 * and the two never wait on each other in a circle.
 */
export async function countOpenRequestsOfPartner(tx: Prisma.TransactionClient, partnerId: string) {
  await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${partnerId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT 1 FROM partner_profiles WHERE user_id = ${partnerId}::uuid FOR UPDATE`;
  return tx.partnerRequest.count({ where: { AND: [{ partnerId }, OPEN_REQUEST_WHERE] } });
}

/**
 * Open requests a staff member handles (DEC-172), inside the caller's transaction. Locks the
 * person's user row: assigning a request to a Sales Executive locks the same row (T5).
 *
 * For a Sales Executive, call it AFTER their partners' Sales Executive links are cleared:
 * that update waits for any new request still being saved for those partners (which routes
 * to this Sales Executive), so this count sees it; later requests go to the ASM.
 */
export async function countOpenRequestsHandledBy(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
  return tx.partnerRequest.count({ where: { AND: [{ handlerId: userId }, OPEN_REQUEST_WHERE] } });
}

// ---------------------------------------------------------------------------
// Request numbers: REQ-<year>-<6 digits>, restarting each UTC year (DEC-163).
// ---------------------------------------------------------------------------

export function formatRequestNo(year: number, seq: number): string {
  return `REQ-${year}-${String(seq).padStart(6, "0")}`;
}

/** The next number in this UTC year. One lock, so two requests never share a number. */
async function nextRequestNumber(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"request:request_no"}::text, 0))`;
  const year = new Date().getUTCFullYear();
  const last = await tx.partnerRequest.aggregate({ where: { year }, _max: { seq: true } });
  const seq = (last._max.seq ?? 0) + 1;
  return { year, seq, requestNo: formatRequestNo(year, seq) };
}

// ---------------------------------------------------------------------------
// What the partner sees (DEC-163, DEC-169)
// ---------------------------------------------------------------------------

const PARTNER_REQUEST_FIELDS = {
  id: true,
  requestNo: true,
  category: true,
  status: true,
  deliveryAddress: true,
  preferredDeliveryDate: true,
  notes: true,
  agreedAmount: true,
  rejectReason: true,
  cancelReason: true,
  createdAt: true,
  updatedAt: true,
  handler: { select: { name: true, phone: true } },
  items: {
    orderBy: { createdAt: "asc" },
    select: { productId: true, productSku: true, productName: true, quantity: true },
  },
  // Stage moves only (not handler changes), oldest first, no names (DEC-169).
  events: {
    where: { toStatus: { not: null } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { toStatus: true, createdAt: true },
  },
} satisfies Prisma.PartnerRequestSelect;

type PartnerRequestRow = Prisma.PartnerRequestGetPayload<{
  select: typeof PARTNER_REQUEST_FIELDS;
}>;

/**
 * One request for the partner's own app: products, current stage, agreed price, the current
 * handler's name and phone (DEC-163, DEC-169), and a timeline of stages with dates only.
 * No payment / refund details beyond the stage (DEC-169), no staff names on the timeline.
 */
export function toPartnerRequest(row: PartnerRequestRow) {
  return {
    id: row.id,
    requestNo: row.requestNo,
    category: row.category,
    status: row.status,
    items: row.items.map((item) => ({
      productId: item.productId,
      sku: item.productSku,
      name: item.productName,
      quantity: item.quantity,
    })),
    deliveryAddress: row.deliveryAddress,
    preferredDeliveryDate: isoFromDate(row.preferredDeliveryDate),
    notes: row.notes,
    agreedAmount: row.agreedAmount ? row.agreedAmount.toFixed(2) : null,
    handler: { name: row.handler.name, phone: row.handler.phone },
    rejectReason: row.rejectReason,
    cancelReason: row.cancelReason,
    timeline: row.events.map((event) => ({ status: event.toStatus!, at: event.createdAt })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A shorter row for the partner's list. */
const PARTNER_LIST_FIELDS = {
  id: true,
  requestNo: true,
  category: true,
  status: true,
  preferredDeliveryDate: true,
  agreedAmount: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { items: true } },
} satisfies Prisma.PartnerRequestSelect;

type PartnerListRow = Prisma.PartnerRequestGetPayload<{ select: typeof PARTNER_LIST_FIELDS }>;

function toPartnerListItem(row: PartnerListRow) {
  return {
    id: row.id,
    requestNo: row.requestNo,
    category: row.category,
    status: row.status,
    itemCount: row._count.items,
    preferredDeliveryDate: isoFromDate(row.preferredDeliveryDate),
    agreedAmount: row.agreedAmount ? row.agreedAmount.toFixed(2) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// T3: the partner sends a request
// ---------------------------------------------------------------------------

/**
 * POST /api/partner/requests. The route guards already made sure the caller is a verified
 * partner with `requests.create`. In ONE transaction:
 *   1. lock the partner's rows: this partner's requests wait in line (so the retry check is
 *      reliable), and a transfer / Sales Executive change can't happen meanwhile (DEC-165);
 *   2. same `Idempotency-Key` already used: same details → that request (a retry, nothing
 *      new); other details → 409 IDEMPOTENCY_KEY_REUSED (DEC-169);
 *   3. every product switched on (`assertProductUsable`, DEC-109); name and SKU copied
 *      (DEC-165);
 *   4. handler = the partner's Sales Executive, else the owning ASM (DEC-158); zone and
 *      owning ASM copied;
 *   5. new REQ number; save the request, its items, the first timeline row and audit
 *      `request.create`.
 */
export async function createMyRequest(partnerId: string, key: string, input: CreateRequestInput) {
  const { requestId, alreadyMade } = await prisma.$transaction(
    (tx) => createRequest(tx, partnerId, key, input),
    REQUEST_TX_OPTIONS
  );
  const row = await prisma.partnerRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: PARTNER_REQUEST_FIELDS,
  });
  return {
    /** True when this is a retry of a request already made: nothing new was made. */
    alreadyMade,
    request: toPartnerRequest(row),
  };
}

/** Do two sets of request details match? (for the retry check) */
function sameDetails(
  existing: {
    category: string;
    deliveryAddress: string;
    preferredDeliveryDate: Date;
    notes: string | null;
    items: { productId: string; quantity: number }[];
  },
  input: CreateRequestInput
): boolean {
  if (
    existing.category !== input.category ||
    existing.deliveryAddress !== input.deliveryAddress ||
    isoFromDate(existing.preferredDeliveryDate) !== input.preferredDeliveryDate ||
    existing.notes !== input.notes ||
    existing.items.length !== input.items.length
  ) {
    return false;
  }
  const wanted = new Map(input.items.map((item) => [item.productId, item.quantity]));
  return existing.items.every((item) => wanted.get(item.productId) === item.quantity);
}

/**
 * The creation itself, inside the caller's transaction. Separate so checks can run it in a
 * transaction that is rolled back.
 */
export async function createRequest(
  tx: Prisma.TransactionClient,
  partnerId: string,
  key: string,
  input: CreateRequestInput
): Promise<{ requestId: string; alreadyMade: boolean }> {
  // 1. Partner rows locked: the user row against a transfer (its owner), the profile row
  //    against a Sales Executive change and against this partner's other requests.
  await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${partnerId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT 1 FROM partner_profiles WHERE user_id = ${partnerId}::uuid FOR UPDATE`;

  // 2. Retry check, under the lock.
  const existing = await tx.partnerRequest.findUnique({
    where: { partnerId_idempotencyKey: { partnerId, idempotencyKey: key } },
    select: {
      id: true,
      category: true,
      deliveryAddress: true,
      preferredDeliveryDate: true,
      notes: true,
      items: { select: { productId: true, quantity: true } },
    },
  });
  if (existing) {
    if (!sameDetails(existing, input)) throw new RequestKeyReusedError();
    return { requestId: existing.id, alreadyMade: true };
  }

  // 3. Products (checked after the retry check, so a retry still works if one was switched off).
  const products = [];
  for (const item of input.items) {
    const product = await assertProductUsable(item.productId, "request", tx);
    products.push({ ...product, quantity: item.quantity });
  }

  // 4. Handler, zone and owning ASM, from the database (not the login token).
  const partner = await tx.user.findUniqueOrThrow({
    where: { id: partnerId },
    select: {
      zoneId: true,
      parentId: true,
      partnerProfile: { select: { salesExecutiveId: true } },
    },
  });
  const handlerId = partner.partnerProfile?.salesExecutiveId ?? partner.parentId;
  if (!handlerId) {
    // A verified partner always has an owning ASM; a missing one is a data problem.
    logger.error({ partnerId }, "Verified partner has no owning ASM");
    throw new AppError("Your request could not be sent. Please contact support.");
  }

  // 5. Save, timeline, audit.
  const { year, seq, requestNo } = await nextRequestNumber(tx);
  const request = await tx.partnerRequest.create({
    data: {
      requestNo,
      year,
      seq,
      partnerId,
      category: input.category,
      status: "requested",
      handlerId,
      zoneId: partner.zoneId,
      owningAsmId: partner.parentId,
      deliveryAddress: input.deliveryAddress,
      preferredDeliveryDate: dateFromIso(input.preferredDeliveryDate),
      notes: input.notes,
      idempotencyKey: key,
      items: {
        create: products.map((product) => ({
          productId: product.id,
          quantity: product.quantity,
          productName: product.name,
          productSku: product.sku,
        })),
      },
      events: {
        create: {
          type: "created",
          toStatus: "requested",
          toHandlerId: handlerId,
          actorId: partnerId,
        },
      },
    },
    select: { id: true },
  });

  await recordAudit(tx, {
    actorId: partnerId,
    action: "request.create",
    entity: { type: "request", id: request.id },
    after: {
      requestNo,
      status: "requested",
      category: input.category,
      handlerId,
      items: products.map((product) => ({ productId: product.id, quantity: product.quantity })),
      preferredDeliveryDate: input.preferredDeliveryDate,
    },
  });

  return { requestId: request.id, alreadyMade: false };
}

// ---------------------------------------------------------------------------
// T3: the partner's own list, details and cancel
// ---------------------------------------------------------------------------

/** GET /api/partner/requests — own requests, newest first, optional stage / kind. */
export async function listMyRequests(
  partnerId: string,
  query: MyRequestsQuery,
  db: Prisma.TransactionClient = prisma
) {
  const where: Prisma.PartnerRequestWhereInput = {
    partnerId,
    ...(query.status && { status: query.status }),
    ...(query.category && { category: query.category }),
  };
  const [rows, total] = await Promise.all([
    db.partnerRequest.findMany({
      where,
      orderBy: toPrismaOrderBy(query.sort),
      ...toPrismaPaging(query.page, query.limit),
      select: PARTNER_LIST_FIELDS,
    }),
    db.partnerRequest.count({ where }),
  ]);
  return { items: rows.map(toPartnerListItem), meta: pageMeta(query.page, query.limit, total) };
}

/** GET /api/partner/requests/:id — one own request; someone else's → 404. */
export async function getMyRequest(
  partnerId: string,
  requestId: string,
  db: Prisma.TransactionClient = prisma
) {
  const row = await db.partnerRequest.findFirst({
    where: { id: requestId, partnerId },
    select: PARTNER_REQUEST_FIELDS,
  });
  if (!row) throw new NotFoundError("Request not found");
  return toPartnerRequest(row);
}

/** POST /api/partner/requests/:id/cancel — the partner cancels their own request. */
export async function cancelMyRequest(
  partnerId: string,
  requestId: string,
  input: CancelRequestInput
) {
  const { alreadyDone } = await prisma.$transaction(
    (tx) => cancelMyRequestInTx(tx, partnerId, requestId, input),
    REQUEST_TX_OPTIONS
  );
  return { alreadyDone, request: await getMyRequest(partnerId, requestId) };
}

/**
 * Partner cancel (DEC-160, DEC-161): own request only (else 404), from Requested up to
 * Processing, reason required. Already cancelled (or into the refund stages) → nothing
 * changes (`alreadyDone`). Dispatched or later, or rejected → 409. If money was received,
 * the handler then moves it to Refund Initiated → Refunded (T4); the app just shows
 * "Cancelled" until then (DEC-169). Timeline row (with the reason) + audit `request.cancel`.
 */
export async function cancelMyRequestInTx(
  tx: Prisma.TransactionClient,
  partnerId: string,
  requestId: string,
  input: CancelRequestInput
): Promise<{ alreadyDone: boolean }> {
  const found = await tx.partnerRequest.findFirst({
    where: { id: requestId, partnerId },
    select: { id: true },
  });
  if (!found) throw new NotFoundError("Request not found");

  await tx.$queryRaw`SELECT 1 FROM partner_requests WHERE id = ${requestId}::uuid FOR UPDATE`;
  const request = await tx.partnerRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: { requestNo: true, status: true, paymentDate: true },
  });

  if (
    request.status === "cancelled" ||
    request.status === "refund_initiated" ||
    request.status === "refunded"
  ) {
    return { alreadyDone: true };
  }
  if (!CANCELLABLE_STATUSES.includes(request.status)) {
    throw new RequestStatusError(request.status, "cancelled");
  }

  await tx.partnerRequest.update({
    where: { id: requestId },
    data: {
      status: "cancelled",
      cancelReason: input.reason,
      events: {
        create: {
          type: "status_change",
          fromStatus: request.status,
          toStatus: "cancelled",
          reason: input.reason,
          actorId: partnerId,
        },
      },
    },
  });
  await recordAudit(tx, {
    actorId: partnerId,
    action: "request.cancel",
    entity: { type: "request", id: requestId },
    before: { status: request.status },
    after: {
      status: "cancelled",
      requestNo: request.requestNo,
      reason: input.reason,
      byPartner: true,
      refundDue: request.paymentDate !== null,
    },
  });
  return { alreadyDone: false };
}

// ---------------------------------------------------------------------------
// What staff see (T4 returns it after each step; T6 lists and details use it too)
// ---------------------------------------------------------------------------

const PERSON = { select: { id: true, name: true } } as const;

const STAFF_REQUEST_FIELDS = {
  id: true,
  requestNo: true,
  category: true,
  status: true,
  deliveryAddress: true,
  preferredDeliveryDate: true,
  notes: true,
  agreedAmount: true,
  paymentDate: true,
  paymentMode: true,
  paymentReference: true,
  paymentReceiptUrl: true,
  paymentRecordedAt: true,
  refundDate: true,
  refundMode: true,
  refundReference: true,
  refundReceiptUrl: true,
  refundRecordedAt: true,
  rejectReason: true,
  cancelReason: true,
  createdAt: true,
  updatedAt: true,
  partner: {
    select: {
      id: true,
      name: true,
      phone: true,
      partnerProfile: { select: { businessName: true } },
    },
  },
  handler: { select: { id: true, name: true, phone: true, roleId: true } },
  zone: { select: { id: true, name: true } },
  owningAsm: PERSON,
  paymentRecordedBy: PERSON,
  refundRecordedBy: PERSON,
  items: {
    orderBy: { createdAt: "asc" },
    select: { productId: true, productSku: true, productName: true, quantity: true },
  },
  events: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      type: true,
      fromStatus: true,
      toStatus: true,
      reason: true,
      createdAt: true,
      actor: PERSON,
      fromHandler: PERSON,
      toHandler: PERSON,
    },
  },
} satisfies Prisma.PartnerRequestSelect;

type StaffRequestRow = Prisma.PartnerRequestGetPayload<{ select: typeof STAFF_REQUEST_FIELDS }>;

/**
 * One request for staff: everything, including the payment / refund details with the receipt
 * links, who recorded them, and the full timeline with names and handler changes (DEC-166).
 */
export function toStaffRequest(row: StaffRequestRow) {
  const money = (
    date: Date | null,
    mode: string | null,
    reference: string | null,
    receiptUrl: string | null,
    by: { id: string; name: string | null } | null,
    at: Date | null
  ) =>
    date
      ? { date: isoFromDate(date), mode, reference, receiptUrl, recordedBy: by, recordedAt: at }
      : null;

  return {
    id: row.id,
    requestNo: row.requestNo,
    category: row.category,
    status: row.status,
    partner: {
      id: row.partner.id,
      name: row.partner.name,
      phone: row.partner.phone,
      businessName: row.partner.partnerProfile?.businessName ?? null,
    },
    handler: {
      id: row.handler.id,
      name: row.handler.name,
      phone: row.handler.phone,
      role: row.handler.roleId === ROLE.ASM ? "asm" : "sales_executive",
    },
    zoneAtRequest: row.zone,
    owningAsmAtRequest: row.owningAsm,
    items: row.items.map((item) => ({
      productId: item.productId,
      sku: item.productSku,
      name: item.productName,
      quantity: item.quantity,
    })),
    deliveryAddress: row.deliveryAddress,
    preferredDeliveryDate: isoFromDate(row.preferredDeliveryDate),
    notes: row.notes,
    agreedAmount: row.agreedAmount ? row.agreedAmount.toFixed(2) : null,
    payment: money(
      row.paymentDate,
      row.paymentMode,
      row.paymentReference,
      row.paymentReceiptUrl,
      row.paymentRecordedBy,
      row.paymentRecordedAt
    ),
    refund: money(
      row.refundDate,
      row.refundMode,
      row.refundReference,
      row.refundReceiptUrl,
      row.refundRecordedBy,
      row.refundRecordedAt
    ),
    rejectReason: row.rejectReason,
    cancelReason: row.cancelReason,
    timeline: row.events,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// T4: the handler's steps (DEC-159 – DEC-164, DEC-170)
// ---------------------------------------------------------------------------

/**
 * Requests the caller may move (`requests.handle`, DEC-164): a Sales Executive the ones they
 * handle; an ASM their own and those handled by their Sales Executives. Anything else → 404.
 */
export function handlerWhere(me: AuthUser): Prisma.PartnerRequestWhereInput {
  if (me.roleId === ROLE.ASM) {
    return {
      OR: [{ handlerId: me.id }, { handler: { parentId: me.id, roleId: ROLE.SALES_EXECUTIVE } }],
    };
  }
  return { handlerId: me.id };
}

export type HandlerStep =
  | "accept"
  | "reject"
  | "payment_received"
  | "processing"
  | "dispatched"
  | "delivered"
  | "completed"
  | "cancel"
  | "refund_initiated"
  | "refunded";

/** One handler action and what it carries. */
export type HandlerAction =
  | { step: "accept"; input: AcceptRequestInput }
  | { step: "reject" | "cancel"; input: RejectRequestInput }
  | { step: "payment_received" | "refunded"; input: MoneyStepInput }
  | { step: "processing" | "dispatched" | "delivered" | "completed" | "refund_initiated" };

/** The stage each step moves to. */
export const STEP_TARGET: Record<HandlerStep, RequestStatus> = {
  accept: "accepted",
  reject: "rejected",
  payment_received: "payment_received",
  processing: "processing",
  dispatched: "dispatched",
  delivered: "delivered",
  completed: "completed",
  cancel: "cancelled",
  refund_initiated: "refund_initiated",
  refunded: "refunded",
};

/** Words for messages: "This request is X, so it can't be <label>." */
export const STEP_LABEL: Record<HandlerStep, string> = {
  accept: "accepted",
  reject: "rejected",
  payment_received: "marked payment received",
  processing: "moved to processing",
  dispatched: "marked dispatched",
  delivered: "marked delivered",
  completed: "marked completed",
  cancel: "cancelled",
  refund_initiated: "moved to refund initiated",
  refunded: "marked refunded",
};

type StepState = {
  category: "shipment" | "sample";
  status: RequestStatus;
  paymentDate: Date | null;
};

/** The one stage each step may start from (DEC-159, DEC-161, DEC-162). Never skip, never back. */
function stepAllowed(step: HandlerStep, now: StepState): boolean {
  switch (step) {
    case "accept":
    case "reject":
      return now.status === "requested";
    case "payment_received":
      return now.category === "shipment" && now.status === "accepted";
    case "processing":
      return now.category === "sample"
        ? now.status === "accepted"
        : now.status === "payment_received";
    case "dispatched":
      return now.status === "processing";
    case "delivered":
      return now.status === "dispatched";
    case "completed":
      return now.status === "delivered";
    case "cancel":
      return CANCELLABLE_STATUSES.includes(now.status);
    case "refund_initiated":
      return now.status === "cancelled" && now.paymentDate !== null;
    case "refunded":
      return now.status === "refund_initiated";
  }
}

/** Pressed again (DEC-170): the step's stage is already reached → 200, nothing changes. */
function stepAlreadyDone(step: HandlerStep, now: StepState): boolean {
  if (step === "cancel") {
    return ["cancelled", "refund_initiated", "refunded"].includes(now.status);
  }
  return now.status === STEP_TARGET[step];
}

/** A clear 409 for a step the request's stage (or kind) doesn't allow. */
function stepError(step: HandlerStep, now: StepState): AppError {
  if (step === "payment_received" && now.category === "sample") {
    return new RequestStatusError(
      now.status,
      STEP_LABEL[step],
      "Samples are free: there is no payment step."
    );
  }
  if (step === "refund_initiated" && now.status === "cancelled") {
    return new RequestStatusError(
      now.status,
      STEP_LABEL[step],
      "No money was received for this request, so there is nothing to refund."
    );
  }
  return new RequestStatusError(now.status, STEP_LABEL[step]);
}

/**
 * Runs one handler step and returns the request as staff see it. A receipt is checked in R2
 * before the transaction (never hold locks over a network call).
 */
export async function runHandlerStep(me: AuthUser, requestId: string, action: HandlerAction) {
  if (action.step === "payment_received" || action.step === "refunded") {
    if (action.input.receiptUrl) {
      await verifyUploadedFile(me, "request_receipt", action.input.receiptUrl, "receipt");
    }
  }
  const { alreadyDone } = await prisma.$transaction(
    (tx) => handlerStepInTx(tx, me, requestId, action),
    REQUEST_TX_OPTIONS
  );
  const row = await prisma.partnerRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: STAFF_REQUEST_FIELDS,
  });
  return { alreadyDone, request: toStaffRequest(row) };
}

/**
 * One handler step inside the caller's transaction:
 *   1. lock the request row, then check the caller may move it (handler side, DEC-164) —
 *      after the lock, so an ASM hand-over in between is respected; otherwise 404;
 *   2. already at the step's stage → `alreadyDone`, nothing changes (DEC-170);
 *   3. wrong stage (or a sample's payment, or a refund with no money) → 409;
 *   4. the step's own data: price (accept), reason (reject / cancel), money details
 *      (payment received / refunded); everything permanent (DEC-162, DEC-170);
 *   5. new stage + timeline row (who, when, reason) + audit `request.<step>`.
 */
export async function handlerStepInTx(
  tx: Prisma.TransactionClient,
  me: AuthUser,
  requestId: string,
  action: HandlerAction
): Promise<{ alreadyDone: boolean }> {
  await tx.$queryRaw`SELECT 1 FROM partner_requests WHERE id = ${requestId}::uuid FOR UPDATE`;
  const now = await tx.partnerRequest.findFirst({
    where: { AND: [{ id: requestId }, handlerWhere(me)] },
    select: {
      requestNo: true,
      partnerId: true,
      category: true,
      status: true,
      agreedAmount: true,
      paymentDate: true,
    },
  });
  if (!now) throw new NotFoundError("Request not found");

  const { step } = action;
  if (stepAlreadyDone(step, now)) return { alreadyDone: true };
  if (!stepAllowed(step, now)) throw stepError(step, now);

  const target = STEP_TARGET[step];
  const data: Prisma.PartnerRequestUpdateInput = { status: target };
  const details: Record<string, unknown> = {};
  let reason: string | null = null;

  switch (action.step) {
    case "accept": {
      const amount = action.input.agreedAmount;
      if (now.category === "shipment") {
        if (amount === undefined) {
          throw new ValidationError("Invalid request data", [
            { path: "body.agreedAmount", message: "agreedAmount is required for a shipment" },
          ]);
        }
        data.agreedAmount = amount;
        details.agreedAmount = amount;
      } else if (amount !== undefined) {
        throw new ValidationError("Invalid request data", [
          { path: "body.agreedAmount", message: "Samples are free: leave agreedAmount out" },
        ]);
      }
      break;
    }
    case "reject":
      reason = action.input.reason;
      data.rejectReason = reason;
      break;
    case "cancel":
      reason = action.input.reason;
      data.cancelReason = reason;
      details.byPartner = false;
      details.refundDue = now.paymentDate !== null;
      break;
    case "payment_received": {
      const money = action.input;
      data.paymentDate = dateFromIso(money.date);
      data.paymentMode = money.mode;
      data.paymentReference = money.reference;
      data.paymentReceiptUrl = money.receiptUrl;
      data.paymentRecordedBy = { connect: { id: me.id } };
      data.paymentRecordedAt = new Date();
      Object.assign(details, money, { amount: now.agreedAmount?.toFixed(2) ?? null });
      break;
    }
    case "refunded": {
      const money = action.input;
      const paidOn = isoFromDate(now.paymentDate);
      if (paidOn && money.date < paidOn) {
        throw new ValidationError("Invalid request data", [
          { path: "body.date", message: `date can't be before the payment date (${paidOn})` },
        ]);
      }
      data.refundDate = dateFromIso(money.date);
      data.refundMode = money.mode;
      data.refundReference = money.reference;
      data.refundReceiptUrl = money.receiptUrl;
      data.refundRecordedBy = { connect: { id: me.id } };
      data.refundRecordedAt = new Date();
      // Always the full agreed amount (DEC-163).
      Object.assign(details, money, { amount: now.agreedAmount?.toFixed(2) ?? null });
      break;
    }
    default:
      break;
  }

  data.events = {
    create: {
      type: "status_change",
      fromStatus: now.status,
      toStatus: target,
      reason,
      actor: { connect: { id: me.id } },
    },
  };
  await tx.partnerRequest.update({ where: { id: requestId }, data });
  await recordAudit(tx, {
    actorId: me.id,
    action: `request.${step}`,
    entity: { type: "request", id: requestId },
    before: { status: now.status },
    after: {
      status: target,
      requestNo: now.requestNo,
      partnerId: now.partnerId,
      ...(reason && { reason }),
      ...details,
    },
  });
  return { alreadyDone: false };
}

// ---------------------------------------------------------------------------
// T5: the ASM gives a request to a Sales Executive, moves it, or takes it back
// (DEC-160, DEC-164, DEC-171, DEC-172). `requests.delegate` = ASM only.
// ---------------------------------------------------------------------------

type HandOver =
  | { kind: "assign"; input: AssignRequestInput }
  | { kind: "take_back"; input: TakeBackRequestInput };

/** Runs an assign / take-back and returns the request as staff see it. */
export async function runHandOver(me: AuthUser, requestId: string, action: HandOver) {
  const { alreadyDone } = await prisma.$transaction(
    (tx) => handOverInTx(tx, me, requestId, action),
    REQUEST_TX_OPTIONS
  );
  const row = await prisma.partnerRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: STAFF_REQUEST_FIELDS,
  });
  return { alreadyDone, request: toStaffRequest(row) };
}

/**
 * Assign / take back, inside the caller's transaction:
 *   1. lock the request row; it must be the ASM's own or their Sales Executives' (else 404);
 *   2. it must be open — any open stage is fine (DEC-172); finished → 409;
 *   3. assign: the new handler must be one of the ASM's own ACTIVE Sales Executives (not
 *      theirs → 404; switched off or suspended → 409); their user row is locked so they
 *      can't be deactivated / moved meanwhile. Take back: the ASM becomes the handler;
 *   4. already with that person → `alreadyDone`, nothing changes;
 *   5. new handler + timeline row (from → to, reason) + audit `request.assign` /
 *      `request.take_back`. Only this request changes, not the partner's Sales Executive.
 */
export async function handOverInTx(
  tx: Prisma.TransactionClient,
  me: AuthUser,
  requestId: string,
  action: HandOver
): Promise<{ alreadyDone: boolean }> {
  await tx.$queryRaw`SELECT 1 FROM partner_requests WHERE id = ${requestId}::uuid FOR UPDATE`;
  const now = await tx.partnerRequest.findFirst({
    where: { AND: [{ id: requestId }, handlerWhere(me)] },
    select: { requestNo: true, partnerId: true, status: true, handlerId: true },
  });
  if (!now) throw new NotFoundError("Request not found");

  const open = await tx.partnerRequest.count({
    where: { AND: [{ id: requestId }, OPEN_REQUEST_WHERE] },
  });
  if (open === 0) {
    throw new RequestStatusError(
      now.status,
      action.kind === "assign" ? "assigned" : "taken back",
      `This request is finished (${now.status}), so its handler can't be changed.`
    );
  }

  let toHandlerId = me.id;
  if (action.kind === "assign") {
    const se = await tx.user.findFirst({
      where: {
        id: action.input.salesExecutiveId,
        roleId: ROLE.SALES_EXECUTIVE,
        parentId: me.id,
      },
      select: { id: true },
    });
    if (!se) throw new NotFoundError("Sales Executive not found");
    await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${se.id}::uuid FOR SHARE`;
    const fresh = await tx.user.findUniqueOrThrow({
      where: { id: se.id },
      select: { status: true, parentId: true },
    });
    if (fresh.parentId !== me.id) throw new NotFoundError("Sales Executive not found");
    if (fresh.status !== "active") {
      throw new AppError(
        "This Sales Executive is not active. Choose an active one.",
        409,
        "SALES_EXECUTIVE_NOT_ACTIVE"
      );
    }
    toHandlerId = se.id;
  }

  if (now.handlerId === toHandlerId) return { alreadyDone: true };

  const reason = action.input.reason;
  await tx.partnerRequest.update({
    where: { id: requestId },
    data: {
      handler: { connect: { id: toHandlerId } },
      events: {
        create: {
          type: "handler_change",
          fromHandler: { connect: { id: now.handlerId } },
          toHandler: { connect: { id: toHandlerId } },
          reason,
          actor: { connect: { id: me.id } },
        },
      },
    },
  });
  await recordAudit(tx, {
    actorId: me.id,
    action: action.kind === "assign" ? "request.assign" : "request.take_back",
    entity: { type: "request", id: requestId },
    before: { handlerId: now.handlerId },
    after: {
      handlerId: toHandlerId,
      requestNo: now.requestNo,
      partnerId: now.partnerId,
      status: now.status,
      reason,
    },
  });
  return { alreadyDone: false };
}

// ---------------------------------------------------------------------------
// T6: staff lists, details, partner history, Partner 360 box (DEC-173). Read-only.
// ---------------------------------------------------------------------------

/** A shorter row for staff lists (worklist, partner history). */
const STAFF_LIST_FIELDS = {
  id: true,
  requestNo: true,
  category: true,
  status: true,
  agreedAmount: true,
  preferredDeliveryDate: true,
  paymentDate: true,
  createdAt: true,
  updatedAt: true,
  partner: {
    select: {
      id: true,
      name: true,
      phone: true,
      partnerProfile: { select: { businessName: true } },
    },
  },
  handler: { select: { id: true, name: true, roleId: true } },
  _count: { select: { items: true } },
} satisfies Prisma.PartnerRequestSelect;

type StaffListRow = Prisma.PartnerRequestGetPayload<{ select: typeof STAFF_LIST_FIELDS }>;

function toStaffListItem(row: StaffListRow) {
  return {
    id: row.id,
    requestNo: row.requestNo,
    category: row.category,
    status: row.status,
    partner: {
      id: row.partner.id,
      name: row.partner.name,
      phone: row.partner.phone,
      businessName: row.partner.partnerProfile?.businessName ?? null,
    },
    handler: {
      id: row.handler.id,
      name: row.handler.name,
      role: row.handler.roleId === ROLE.ASM ? "asm" : "sales_executive",
    },
    itemCount: row._count.items,
    agreedAmount: row.agreedAmount ? row.agreedAmount.toFixed(2) : null,
    preferredDeliveryDate: isoFromDate(row.preferredDeliveryDate),
    /** True for a cancelled request still waiting for its refund (it counts as open). */
    refundDue: row.status === "cancelled" && row.paymentDate !== null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** "Made between" (both ends included); nothing when neither is given. */
function madeBetween(from?: Date, to?: Date): Prisma.PartnerRequestWhereInput {
  if (!from && !to) return {};
  return { createdAt: { ...(from && { gte: from }), ...(to && { lte: to }) } };
}

/**
 * Part of the request number, or of the partner's name, business name or phone (any case).
 * A list to spread into an `AND` (empty when there is no search).
 */
function searchWhere(search?: string): Prisma.PartnerRequestWhereInput[] {
  if (!search) return [];
  return [
    {
      OR: [
        { requestNo: { contains: search, mode: "insensitive" } },
        { partner: { name: { contains: search, mode: "insensitive" } } },
        { partner: { phone: { contains: search } } },
        {
          partner: {
            partnerProfile: { is: { businessName: { contains: search, mode: "insensitive" } } },
          },
        },
      ],
    },
  ];
}

/** open / finished / all → a filter (finished = not open, DEC-165, DEC-172). */
function stateWhere(state: "open" | "finished" | "all"): Prisma.PartnerRequestWhereInput {
  if (state === "open") return OPEN_REQUEST_WHERE;
  if (state === "finished") return { NOT: OPEN_REQUEST_WHERE };
  return {};
}

/**
 * GET /api/requests/worklist — `requests.handle`: requests I handle; an ASM also their
 * Sales Executives' (`handlerWhere`). Open by default, newest first (DEC-173).
 */
export async function listWorklist(
  me: AuthUser,
  query: WorklistQuery,
  db: Prisma.TransactionClient = prisma
) {
  const where: Prisma.PartnerRequestWhereInput = {
    AND: [
      handlerWhere(me),
      stateWhere(query.state),
      {
        ...(query.status && { status: query.status }),
        ...(query.category && { category: query.category }),
        ...(query.handlerId && { handlerId: query.handlerId }),
        ...madeBetween(query.from, query.to),
      },
      ...searchWhere(query.search),
    ],
  };
  const [rows, total] = await Promise.all([
    db.partnerRequest.findMany({
      where,
      orderBy: toPrismaOrderBy(query.sort),
      ...toPrismaPaging(query.page, query.limit),
      select: STAFF_LIST_FIELDS,
    }),
    db.partnerRequest.count({ where }),
  ]);
  return { items: rows.map(toStaffListItem), meta: pageMeta(query.page, query.limit, total) };
}

/** The list row plus the partner's current zone (only `GET /requests`, DEC-280). */
const ALL_LIST_FIELDS = {
  ...STAFF_LIST_FIELDS,
  partner: {
    select: {
      ...STAFF_LIST_FIELDS.partner.select,
      zone: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.PartnerRequestSelect;

/**
 * GET /api/requests — every request this web-panel viewer may see (`requests.view`;
 * F9 T1, DEC-279, DEC-280): Admin / Requests Sub-Admin all, Zonal Head partners now in
 * their zone. All states by default, newest first. The filters sit on top of the scope,
 * so one outside it (e.g. another zone) gives an empty list, not an error.
 * - `zoneId`: the partner's current zone.
 * - `handlerId`: the person handling it now.
 * - `asmId`: handled by that ASM or by one of their Sales Executives.
 */
export async function listAllRequests(
  me: AuthUser,
  scope: PermissionScope,
  query: AllRequestsQuery,
  db: Prisma.TransactionClient = prisma
) {
  const where: Prisma.PartnerRequestWhereInput = {
    AND: [
      scopeForRequests(me, scope),
      stateWhere(query.state),
      {
        ...(query.status && { status: query.status }),
        ...(query.category && { category: query.category }),
        ...(query.handlerId && { handlerId: query.handlerId }),
        ...madeBetween(query.from, query.to),
      },
      ...(query.zoneId ? [{ partner: { zoneId: query.zoneId } }] : []),
      ...(query.asmId
        ? [
            {
              OR: [
                { handlerId: query.asmId },
                { handler: { parentId: query.asmId, roleId: ROLE.SALES_EXECUTIVE } },
              ],
            },
          ]
        : []),
      ...searchWhere(query.search),
    ],
  };
  const [rows, total] = await Promise.all([
    db.partnerRequest.findMany({
      where,
      orderBy: toPrismaOrderBy(query.sort),
      ...toPrismaPaging(query.page, query.limit),
      select: ALL_LIST_FIELDS,
    }),
    db.partnerRequest.count({ where }),
  ]);
  return {
    items: rows.map((row) => ({
      ...toStaffListItem(row),
      zone: row.partner.zone ? { id: row.partner.zone.id, name: row.partner.zone.name } : null,
    })),
    meta: pageMeta(query.page, query.limit, total),
  };
}

/** GET /api/requests/:id — full details for any staff viewer within scope (else 404). */
export async function getRequestForStaff(
  me: AuthUser,
  scope: PermissionScope,
  requestId: string,
  db: Prisma.TransactionClient = prisma
) {
  const row = await db.partnerRequest.findFirst({
    where: { AND: [{ id: requestId }, scopeForRequests(me, scope)] },
    select: STAFF_REQUEST_FIELDS,
  });
  return toStaffRequest(assertInScope(row, { user: me, entity: "request", id: requestId }));
}

/**
 * Counts for one partner's requests that this viewer may see (DEC-173): total, open, by kind,
 * by stage, and completed shipments (count + ₹ of the agreed amounts).
 */
async function partnerRequestCounts(
  db: Prisma.TransactionClient,
  where: Prisma.PartnerRequestWhereInput
) {
  const [byStatusAndKind, open, completed] = await Promise.all([
    db.partnerRequest.groupBy({ by: ["status", "category"], where, _count: { _all: true } }),
    db.partnerRequest.count({ where: { AND: [where, OPEN_REQUEST_WHERE] } }),
    db.partnerRequest.aggregate({
      where: { AND: [where, { category: "shipment", status: "completed" }] },
      _count: { _all: true },
      _sum: { agreedAmount: true },
    }),
  ]);
  const byCategory = { shipment: 0, sample: 0 };
  const byStatus: Partial<Record<RequestStatus, number>> = {};
  let total = 0;
  for (const row of byStatusAndKind) {
    const n = row._count._all;
    total += n;
    byCategory[row.category] += n;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + n;
  }
  return {
    total,
    open,
    byCategory,
    byStatus,
    completedShipments: {
      count: completed._count._all,
      amount: (completed._sum.agreedAmount ?? 0).toFixed(2),
    },
  };
}

/**
 * GET /api/partners/:id/requests — one partner's request history for Partner 360
 * (`requests.view` within scope, DEC-173): the counts and the list, newest first.
 * The partner must be in my partner scope, or have at least one request I may see
 * (a Sales Executive handling a request of a partner who isn't assigned to them);
 * otherwise 404.
 */
export async function listPartnerRequests(
  me: AuthUser,
  scope: PermissionScope,
  partnerId: string,
  query: PartnerRequestsQuery,
  db: Prisma.TransactionClient = prisma
) {
  const visible: Prisma.PartnerRequestWhereInput = {
    AND: [{ partnerId }, scopeForRequests(me, scope)],
  };
  const [partnerInScope, anyVisible] = await Promise.all([
    db.user.count({ where: { AND: [{ id: partnerId }, scopeForPartners(me, scope)] } }),
    db.partnerRequest.count({ where: visible }),
  ]);
  if (partnerInScope === 0 && anyVisible === 0) {
    assertInScope(null, { user: me, entity: "partner", id: partnerId });
  }

  const where: Prisma.PartnerRequestWhereInput = {
    AND: [
      visible,
      stateWhere(query.state),
      {
        ...(query.status && { status: query.status }),
        ...(query.category && { category: query.category }),
      },
    ],
  };
  const [counts, rows, total] = await Promise.all([
    partnerRequestCounts(db, visible),
    db.partnerRequest.findMany({
      where,
      orderBy: toPrismaOrderBy(query.sort),
      ...toPrismaPaging(query.page, query.limit),
      select: STAFF_LIST_FIELDS,
    }),
    db.partnerRequest.count({ where }),
  ]);
  return {
    counts,
    items: rows.map(toStaffListItem),
    meta: pageMeta(query.page, query.limit, total),
  };
}

/**
 * The requests box in Partner 360 (DEC-173): only for staff with `requests.view`; otherwise
 * undefined (the box is left out). Counts only the requests this viewer may see.
 */
export async function requestsBoxFor360(
  me: AuthUser,
  partnerId: string,
  db: Prisma.TransactionClient = prisma
) {
  const scope = await getPermissionScope(me, "requests.view");
  if (!scope) return undefined;
  const where: Prisma.PartnerRequestWhereInput = {
    AND: [{ partnerId }, scopeForRequests(me, scope)],
  };
  const [open, total, latest] = await Promise.all([
    db.partnerRequest.count({ where: { AND: [where, OPEN_REQUEST_WHERE] } }),
    db.partnerRequest.count({ where }),
    db.partnerRequest.findFirst({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, requestNo: true, category: true, status: true, createdAt: true },
    }),
  ]);
  return { open, total, latest };
}

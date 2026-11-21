import { ROLE } from "../config/roles.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { PermissionScope, SubAdminArea } from "../generated/prisma/enums.js";
import { decryptValue } from "../lib/crypto/sensitiveData.js";
import { prisma, reportsDb } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { ForbiddenError } from "../utils/errors.js";
import { isoFromDate, todayInIst } from "../utils/istDate.js";
import { pointsToRupees } from "../utils/money.js";
import { dormantCutoff, istMidnight } from "../utils/period.js";
import type { ReportKey, ReportQuery } from "../validators/report.schema.js";
import { recordAudit } from "./audit.service.js";
import { OPEN_REQUEST_WHERE } from "./request.service.js";
import { getSetting } from "./settings.service.js";

/**
 * CSV reports (Module 16 T5; DEC-199, DEC-200, DEC-205, DEC-207, DEC-208, DEC-213, DEC-214,
 * DEC-218, DEC-219, DEC-222, DEC-224).
 * - Download only (no on-screen list). Read through the report connection (DEC-210).
 * - Who: Admin (everything), Zonal Head (their zone), Sub-Admin (the reports of their areas,
 *   DEC-214). ASMs and Sales Executives have no `reports.view` (DEC-200).
 * - Activity (scans, payouts, requests, tasks) counts in the zone saved on the record (where
 *   it happened, DEC-222); partners follow their current zone.
 * - Numbers in full except Aadhaar (last 4, DEC-207). No size limit: rows are read 1,000 at a
 *   time and streamed (DEC-208).
 * - Every download writes ONE audit row before the file is sent: who, report, filters, rows
 *   (DEC-218). Nothing else is written.
 */

type Db = Prisma.TransactionClient;
type Row = readonly unknown[];

/** Rows read per database round trip. */
const PAGE = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Matches nothing (a Zonal Head without a zone). */
const NO_ZONE = "00000000-0000-0000-0000-000000000000";

/** Which Sub-Admin areas open which report (DEC-205, DEC-214). */
const REPORT_AREAS: Record<ReportKey, readonly SubAdminArea[]> = {
  scans: ["rewards", "qr"],
  "points-issued": ["rewards"],
  payouts: ["rewards"],
  partners: ["partners"],
  products: ["products"],
  regions: ["partners"],
  tasks: ["tasks"],
  requests: ["requests"],
};

/** What one report needs to run. */
interface ReportContext {
  db: Db;
  /** Undefined = all zones; otherwise only this zone (a Zonal Head's is forced). */
  zoneId: string | undefined;
  /** India-day range: `gte` from midnight of `from`, `lt` midnight after `to`. Null = no dates. */
  range: { gte: Date; lt: Date } | null;
  cutoff: Date;
}

interface ReportOutput {
  header: string[];
  rowCount: number;
  batches: AsyncIterable<Row[]>;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Reads a table 1,000 rows at a time, in id order. */
async function* paged<T extends { id: string }>(
  read: (page: { take: number; skip?: number; cursor?: { id: string } }) => Promise<T[]>,
  map: (rows: T[]) => Promise<Row[]> | Row[]
): AsyncIterable<Row[]> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await read({
      take: PAGE,
      ...(cursor !== undefined && { skip: 1, cursor: { id: cursor } }),
    });
    if (rows.length > 0) yield await map(rows);
    if (rows.length < PAGE) return;
    cursor = rows[rows.length - 1]!.id;
  }
}

/** Already-built rows as one batch (summary reports, small by nature). */
async function* once(rows: Row[]): AsyncIterable<Row[]> {
  yield rows;
}

const dateIn = (ctx: ReportContext): Prisma.DateTimeFilter | undefined =>
  ctx.range ? { gte: ctx.range.gte, lt: ctx.range.lt } : undefined;

const rupees = (value: Prisma.Decimal | null | undefined) => (value ? value.toFixed(2) : null);

/** Partners who finished sign-up (same rule as the dashboards, DEC-221). */
const SIGNED_UP: Prisma.UserWhereInput = {
  roleId: ROLE.PARTNER,
  partnerProfile: { is: { kycState: { not: "not_submitted" }, draftRemovedAt: null } },
};

const PERSON = { select: { name: true } } as const;

function safeDecrypt(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return decryptValue(value);
  } catch {
    // Never break a whole download (or log the value) because one stored number is unreadable.
    return "(unreadable)";
  }
}

// ---------------------------------------------------------------------------
// The 8 reports
// ---------------------------------------------------------------------------

/** Scans: one row per scan (DEC-224). Zone = where the scan happened. */
async function scansReport(ctx: ReportContext, q: ReportQuery["scans"]): Promise<ReportOutput> {
  const where: Prisma.ScanWhereInput = {
    ...(ctx.range && { scannedAt: dateIn(ctx) }),
    ...(ctx.zoneId !== undefined && { zoneId: ctx.zoneId }),
    ...(q.productId && { productId: q.productId }),
    ...(q.partnerId && { partnerId: q.partnerId }),
  };
  return {
    header: [
      "scanned_at",
      "partner_name",
      "partner_phone",
      "partner_type",
      "business_name",
      "product_sku",
      "product_name",
      "batch_no",
      "qr_code",
      "points",
      "zone",
      "asm",
    ],
    rowCount: await ctx.db.scan.count({ where }),
    batches: paged(
      (page) =>
        ctx.db.scan.findMany({
          where,
          orderBy: { id: "asc" },
          ...page,
          select: {
            id: true,
            scannedAt: true,
            points: true,
            partner: {
              select: {
                name: true,
                phone: true,
                partnerProfile: { select: { partnerType: true, businessName: true } },
              },
            },
            product: { select: { sku: true, name: true } },
            batch: { select: { batchNo: true } },
            qrCode: { select: { code: true } },
            zone: PERSON,
            owningAsm: PERSON,
          },
        }),
      (rows) =>
        rows.map((row) => [
          row.scannedAt,
          row.partner.name,
          row.partner.phone,
          row.partner.partnerProfile?.partnerType,
          row.partner.partnerProfile?.businessName,
          row.product.sku,
          row.product.name,
          row.batch.batchNo,
          row.qrCode.code,
          row.points,
          row.zone?.name,
          row.owningAsm?.name,
        ])
    ),
  };
}

/** Points issued: one row per partner, totals of their scans in the dates (DEC-224). */
async function pointsIssuedReport(ctx: ReportContext): Promise<ReportOutput> {
  const totals = await ctx.db.scan.groupBy({
    by: ["partnerId"],
    where: {
      ...(ctx.range && { scannedAt: dateIn(ctx) }),
      ...(ctx.zoneId !== undefined && { zoneId: ctx.zoneId }),
    },
    _count: { _all: true },
    _sum: { points: true },
  });
  const partners = await ctx.db.user.findMany({
    where: { id: { in: totals.map((row) => row.partnerId) } },
    select: {
      id: true,
      name: true,
      phone: true,
      zone: PERSON,
      parent: PERSON,
      partnerProfile: { select: { partnerType: true, businessName: true } },
    },
  });
  const byId = new Map(partners.map((partner) => [partner.id, partner]));
  const rows = totals
    .map((row) => ({ row, partner: byId.get(row.partnerId) }))
    .sort(
      (a, b) =>
        (b.row._sum.points ?? 0) - (a.row._sum.points ?? 0) ||
        (a.partner?.name ?? "").localeCompare(b.partner?.name ?? "")
    )
    .map(({ row, partner }) => {
      const points = row._sum.points ?? 0;
      return [
        partner?.name,
        partner?.phone,
        partner?.partnerProfile?.partnerType,
        partner?.partnerProfile?.businessName,
        partner?.zone?.name,
        partner?.parent?.name,
        row._count._all,
        points,
        pointsToRupees(points),
      ];
    });
  return {
    header: [
      "partner_name",
      "partner_phone",
      "partner_type",
      "business_name",
      "zone_now",
      "asm_now",
      "scans",
      "points_earned",
      "points_rupees",
    ],
    rowCount: rows.length,
    batches: once(rows),
  };
}

/** Payouts: one row per payout, by request date (DEC-224). Account numbers in full (DEC-207). */
async function payoutsReport(ctx: ReportContext, q: ReportQuery["payouts"]): Promise<ReportOutput> {
  const where: Prisma.PayoutWhereInput = {
    ...(ctx.range && { createdAt: dateIn(ctx) }),
    ...(ctx.zoneId !== undefined && { zoneId: ctx.zoneId }),
    ...(q.status && { status: q.status }),
  };
  return {
    header: [
      "payout_no",
      "requested_at",
      "partner_name",
      "partner_phone",
      "points",
      "amount",
      "status",
      "account_method",
      "account_holder",
      "account_number_or_upi",
      "ifsc",
      "bank_name",
      "zone",
      "asm",
      "approved_by",
      "approved_at",
      "paid_by",
      "paid_at",
      "paid_method",
      "transaction_id",
      "declined_by",
      "declined_at",
      "decline_reason",
      "failed_by",
      "failed_at",
      "failure_reason",
    ],
    rowCount: await ctx.db.payout.count({ where }),
    batches: paged(
      (page) =>
        ctx.db.payout.findMany({
          where,
          orderBy: { id: "asc" },
          ...page,
          include: {
            partner: { select: { name: true, phone: true } },
            zone: PERSON,
            owningAsm: PERSON,
            approvedBy: PERSON,
            paidBy: PERSON,
            declinedBy: PERSON,
            failedBy: PERSON,
          },
        }),
      (rows) =>
        rows.map((row) => [
          row.payoutNo,
          row.createdAt,
          row.partner.name,
          row.partner.phone,
          row.points,
          row.amount.toFixed(2),
          row.status,
          row.accountMethod,
          row.accountHolderName,
          safeDecrypt(row.accountValueEncrypted),
          row.accountIfsc,
          row.accountBankName,
          row.zone?.name,
          row.owningAsm?.name,
          row.approvedBy?.name,
          row.approvedAt,
          row.paidBy?.name,
          row.paidAt,
          row.paidMethod,
          row.transactionId,
          row.declinedBy?.name,
          row.declinedAt,
          row.declineReason,
          row.failedBy?.name,
          row.failedAt,
          row.failureReason,
        ])
    ),
  };
}

/**
 * Partners: one row per signed-up partner, current zone (DEC-224). Dates = optional "joined
 * between". PAN and GST in full, Aadhaar last 4, the default payout account in full (DEC-207).
 */
async function partnersReport(
  ctx: ReportContext,
  q: ReportQuery["partners"]
): Promise<ReportOutput> {
  const live: Prisma.UserWhereInput = {
    status: "active",
    partnerProfile: { is: { kycState: "verified" } },
  };
  const scannedRecently: Prisma.UserWhereInput = {
    scans: { some: { scannedAt: { gte: ctx.cutoff } } },
  };
  const activity: Prisma.UserWhereInput | undefined =
    q.activity === "suspended"
      ? { status: "suspended" }
      : q.activity === "active"
        ? { AND: [live, scannedRecently] }
        : q.activity === "dormant"
          ? { AND: [live, { NOT: scannedRecently }] }
          : undefined;
  const where: Prisma.UserWhereInput = {
    AND: [
      SIGNED_UP,
      ...(ctx.zoneId !== undefined ? [{ zoneId: ctx.zoneId }] : []),
      ...(ctx.range ? [{ createdAt: dateIn(ctx) }] : []),
      ...(q.kycState ? [{ partnerProfile: { is: { kycState: q.kycState } } }] : []),
      ...(q.partnerType ? [{ partnerProfile: { is: { partnerType: q.partnerType } } }] : []),
      ...(activity ? [activity] : []),
    ],
  };

  return {
    header: [
      "partner_name",
      "partner_phone",
      "email",
      "partner_type",
      "business_name",
      "city",
      "state",
      "pincode",
      "zone",
      "asm",
      "sales_executive",
      "kyc_state",
      "account_status",
      "activity",
      "joined_at",
      "verified_at",
      "last_scan_at",
      "pan",
      "aadhaar_last4",
      "gst",
      "default_account_method",
      "default_account_holder",
      "default_account_number_or_upi",
      "default_account_ifsc",
      "default_account_bank",
      "wallet_available",
      "wallet_held",
    ],
    rowCount: await ctx.db.user.count({ where }),
    batches: paged(
      (page) =>
        ctx.db.user.findMany({
          where,
          orderBy: { id: "asc" },
          ...page,
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            status: true,
            createdAt: true,
            zone: PERSON,
            parent: PERSON,
            partnerProfile: {
              select: {
                partnerType: true,
                businessName: true,
                city: true,
                state: true,
                pincode: true,
                kycState: true,
                reviewedAt: true,
                salesExecutive: PERSON,
              },
            },
          },
        }),
      async (rows) => {
        const ids = rows.map((row) => row.id);
        const [lastScans, docs, accounts, wallets] = await Promise.all([
          ctx.db.scan.groupBy({
            by: ["partnerId"],
            where: { partnerId: { in: ids } },
            _max: { scannedAt: true },
          }),
          ctx.db.kycDocument.findMany({
            where: { partnerId: { in: ids }, replacedAt: null },
            select: { partnerId: true, docType: true, numberEncrypted: true, numberLast4: true },
          }),
          ctx.db.payoutAccount.findMany({
            where: { partnerId: { in: ids }, removedAt: null, isDefault: true },
            select: {
              partnerId: true,
              method: true,
              holderName: true,
              valueEncrypted: true,
              ifsc: true,
              bankName: true,
            },
          }),
          ctx.db.wallet.findMany({
            where: { partnerId: { in: ids } },
            select: { partnerId: true, available: true, held: true },
          }),
        ]);
        const lastScan = new Map(lastScans.map((row) => [row.partnerId, row._max.scannedAt]));
        const doc = (id: string, type: string) =>
          docs.find((row) => row.partnerId === id && row.docType === type);
        const account = new Map(accounts.map((row) => [row.partnerId, row]));
        const wallet = new Map(wallets.map((row) => [row.partnerId, row]));

        return rows.map((row) => {
          const profile = row.partnerProfile;
          const last = lastScan.get(row.id) ?? null;
          const isLive = row.status === "active" && profile?.kycState === "verified";
          const activityLabel =
            row.status === "suspended"
              ? "suspended"
              : isLive
                ? last && last >= ctx.cutoff
                  ? "active"
                  : "dormant"
                : null;
          const acct = account.get(row.id);
          const purse = wallet.get(row.id);
          return [
            row.name,
            row.phone,
            row.email,
            profile?.partnerType,
            profile?.businessName,
            profile?.city,
            profile?.state,
            profile?.pincode,
            row.zone?.name,
            row.parent?.name,
            profile?.salesExecutive?.name,
            profile?.kycState,
            row.status,
            activityLabel,
            row.createdAt,
            profile?.kycState === "verified" ? profile.reviewedAt : null,
            last,
            safeDecrypt(doc(row.id, "pan")?.numberEncrypted),
            doc(row.id, "aadhaar")?.numberLast4,
            safeDecrypt(doc(row.id, "gst")?.numberEncrypted),
            acct?.method,
            acct?.holderName,
            safeDecrypt(acct?.valueEncrypted),
            acct?.ifsc,
            acct?.bankName,
            purse?.available,
            purse?.held,
          ];
        });
      }
    ),
  };
}

/** Products: one row per product, scans and points in the dates (zone = where scanned). */
async function productsReport(ctx: ReportContext): Promise<ReportOutput> {
  const [products, totals] = await Promise.all([
    ctx.db.product.findMany({
      orderBy: [{ sku: "asc" }, { id: "asc" }],
      select: {
        id: true,
        sku: true,
        name: true,
        active: true,
        mrp: true,
        brand: PERSON,
        category: PERSON,
      },
    }),
    ctx.db.scan.groupBy({
      by: ["productId"],
      where: {
        ...(ctx.range && { scannedAt: dateIn(ctx) }),
        ...(ctx.zoneId !== undefined && { zoneId: ctx.zoneId }),
      },
      _count: { _all: true },
      _sum: { points: true },
    }),
  ]);
  const byId = new Map(totals.map((row) => [row.productId, row]));
  const rows = products.map((product) => {
    const total = byId.get(product.id);
    return [
      product.sku,
      product.name,
      product.brand.name,
      product.category.name,
      product.mrp.toFixed(2),
      product.active,
      total?._count._all ?? 0,
      total?._sum.points ?? 0,
    ];
  });
  return {
    header: ["sku", "product_name", "brand", "category", "mrp", "active", "scans", "points_given"],
    rowCount: rows.length,
    batches: once(rows),
  };
}

/**
 * Regions: one row per zone (DEC-224). Partners: current zone, now. Scans / points / payouts
 * paid (paid date) in the dates and open requests (now): the zone saved on the record.
 */
async function regionsReport(ctx: ReportContext): Promise<ReportOutput> {
  const zones = await ctx.db.zone.findMany({
    where: ctx.zoneId !== undefined ? { id: ctx.zoneId } : {},
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true, code: true, status: true },
  });
  const zoneIds = zones.map((zone) => zone.id);
  const live: Prisma.UserWhereInput = {
    AND: [SIGNED_UP, { status: "active", partnerProfile: { is: { kycState: "verified" } } }],
  };
  const scannedRecently: Prisma.UserWhereInput = {
    scans: { some: { scannedAt: { gte: ctx.cutoff } } },
  };
  const inZones = { zoneId: { in: zoneIds } };

  const [partners, active, dormant, scans, paid, open] = await Promise.all([
    ctx.db.user.groupBy({
      by: ["zoneId"],
      where: { AND: [SIGNED_UP, inZones] },
      _count: { _all: true },
    }),
    ctx.db.user.groupBy({
      by: ["zoneId"],
      where: { AND: [live, scannedRecently, inZones] },
      _count: { _all: true },
    }),
    ctx.db.user.groupBy({
      by: ["zoneId"],
      where: { AND: [live, { NOT: scannedRecently }, inZones] },
      _count: { _all: true },
    }),
    ctx.db.scan.groupBy({
      by: ["zoneId"],
      where: { ...inZones, ...(ctx.range && { scannedAt: dateIn(ctx) }) },
      _count: { _all: true },
      _sum: { points: true },
    }),
    ctx.db.payout.groupBy({
      by: ["zoneId"],
      where: { ...inZones, status: "paid", ...(ctx.range && { paidAt: dateIn(ctx) }) },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    ctx.db.partnerRequest.groupBy({
      by: ["zoneId"],
      where: { AND: [OPEN_REQUEST_WHERE, inZones] },
      _count: { _all: true },
      _sum: { agreedAmount: true },
    }),
  ]);
  const count = (rows: { zoneId: string | null; _count: { _all: number } }[]) =>
    new Map(rows.map((row) => [row.zoneId, row._count._all]));
  const partnersBy = count(partners);
  const activeBy = count(active);
  const dormantBy = count(dormant);
  const scansBy = new Map(scans.map((row) => [row.zoneId, row]));
  const paidBy = new Map(paid.map((row) => [row.zoneId, row]));
  const openBy = new Map(open.map((row) => [row.zoneId, row]));

  const rows = zones.map((zone) => {
    const scan = scansBy.get(zone.id);
    const pay = paidBy.get(zone.id);
    const req = openBy.get(zone.id);
    return [
      zone.name,
      zone.code,
      zone.status,
      partnersBy.get(zone.id) ?? 0,
      activeBy.get(zone.id) ?? 0,
      dormantBy.get(zone.id) ?? 0,
      scan?._count._all ?? 0,
      scan?._sum.points ?? 0,
      pay?._count._all ?? 0,
      rupees(pay?._sum.amount) ?? "0.00",
      req?._count._all ?? 0,
      rupees(req?._sum.agreedAmount) ?? "0.00",
    ];
  });
  return {
    header: [
      "zone",
      "zone_code",
      "zone_status",
      "partners",
      "active_partners",
      "dormant_partners",
      "scans",
      "points",
      "payouts_paid",
      "payouts_paid_amount",
      "open_requests",
      "pipeline_value",
    ],
    rowCount: rows.length,
    batches: once(rows),
  };
}

/** Tasks: one row per task, by the date it was given (zone saved at giving time). */
async function tasksReport(ctx: ReportContext, q: ReportQuery["tasks"]): Promise<ReportOutput> {
  const where: Prisma.TaskWhereInput = {
    ...(ctx.range && { createdAt: dateIn(ctx) }),
    ...(ctx.zoneId !== undefined && { zoneId: ctx.zoneId }),
    ...(q.status && { status: q.status }),
  };
  const today = todayInIst();
  const role = { select: { name: true, role: { select: { name: true } } } } as const;
  return {
    header: [
      "title",
      "category",
      "priority",
      "status",
      "given_by",
      "given_by_role",
      "given_to",
      "given_to_role",
      "zone",
      "given_at",
      "due_date",
      "started_at",
      "completed_at",
      "overdue",
      "on_time",
      "cancelled_at",
      "cancel_reason",
    ],
    rowCount: await ctx.db.task.count({ where }),
    batches: paged(
      (page) =>
        ctx.db.task.findMany({
          where,
          orderBy: { id: "asc" },
          ...page,
          include: { assignedBy: role, assignedTo: role, zone: PERSON },
        }),
      (rows) =>
        rows.map((row) => {
          const due = isoFromDate(row.dueDate) ?? "";
          const unfinished = row.status === "open" || row.status === "in_progress";
          return [
            row.title,
            row.category,
            row.priority,
            row.status,
            row.assignedBy.name,
            row.assignedBy.role.name,
            row.assignedTo.name,
            row.assignedTo.role.name,
            row.zone?.name,
            row.createdAt,
            due,
            row.startedAt,
            row.completedAt,
            unfinished && due < today,
            // On time = completed on or before the due day, India date (DEC-222).
            row.completedAt ? todayInIst(row.completedAt) <= due : null,
            row.cancelledAt,
            row.cancelReason,
          ];
        })
    ),
  };
}

/** Requests: one row per request, by request date (zone saved at request time). */
async function requestsReport(
  ctx: ReportContext,
  q: ReportQuery["requests"]
): Promise<ReportOutput> {
  const where: Prisma.PartnerRequestWhereInput = {
    ...(ctx.range && { createdAt: dateIn(ctx) }),
    ...(ctx.zoneId !== undefined && { zoneId: ctx.zoneId }),
    ...(q.stage && { status: q.stage }),
    ...(q.type && { category: q.type }),
  };
  return {
    header: [
      "request_no",
      "requested_at",
      "partner_name",
      "partner_phone",
      "type",
      "products",
      "stage",
      "agreed_amount",
      "handler",
      "zone",
      "asm",
      "delivery_address",
      "preferred_delivery_date",
      "payment_date",
      "payment_mode",
      "payment_reference",
      "refund_date",
      "refund_mode",
      "refund_reference",
      "reject_reason",
      "cancel_reason",
    ],
    rowCount: await ctx.db.partnerRequest.count({ where }),
    batches: paged(
      (page) =>
        ctx.db.partnerRequest.findMany({
          where,
          orderBy: { id: "asc" },
          ...page,
          include: {
            partner: { select: { name: true, phone: true } },
            handler: PERSON,
            zone: PERSON,
            owningAsm: PERSON,
            items: {
              select: { productSku: true, productName: true, quantity: true },
              orderBy: { createdAt: "asc" },
            },
          },
        }),
      (rows) =>
        rows.map((row) => [
          row.requestNo,
          row.createdAt,
          row.partner.name,
          row.partner.phone,
          row.category,
          row.items
            .map((item) => `${item.productSku} ${item.productName} x ${item.quantity}`)
            .join("; "),
          row.status,
          rupees(row.agreedAmount),
          row.handler.name,
          row.zone?.name,
          row.owningAsm?.name,
          row.deliveryAddress,
          isoFromDate(row.preferredDeliveryDate),
          isoFromDate(row.paymentDate),
          row.paymentMode,
          row.paymentReference,
          isoFromDate(row.refundDate),
          row.refundMode,
          row.refundReference,
          row.rejectReason,
          row.cancelReason,
        ])
    ),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Who may download which report: Admin all; Zonal Head all (own zone); Sub-Admin by area. */
function assertMayDownload(me: AuthUser, key: ReportKey) {
  if (me.roleId === ROLE.SUB_ADMIN) {
    const areas = REPORT_AREAS[key];
    if (!areas.some((area) => me.subAdminAreas.includes(area))) {
      throw new ForbiddenError("This report is not part of your areas.");
    }
  }
}

/**
 * The zone a download is limited to. A Zonal Head ("scoped") always gets their own zone;
 * asking for another zone is refused. Admin / Sub-Admin: the filter they picked, or all.
 */
function zoneFor(me: AuthUser, scope: PermissionScope, requested: string | undefined) {
  if (scope === "full") return requested;
  const own = me.zoneId ?? NO_ZONE;
  if (requested !== undefined && requested !== own) {
    throw new ForbiddenError("You can only download reports for your own zone.");
  }
  return own;
}

/** The India-date range of a download: the dates given, or this month (not for partners). */
function datesFor(key: ReportKey, query: { from?: string; to?: string }) {
  const today = todayInIst();
  if (key === "partners" && !query.from && !query.to) return { from: null, to: null };
  return {
    from: query.from ?? (query.to ? query.to.slice(0, 7) + "-01" : `${today.slice(0, 7)}-01`),
    to: query.to ?? (query.from && query.from > today ? query.from : today),
  };
}

export interface ReportDownload {
  filename: string;
  header: string[];
  rowCount: number;
  batches: AsyncIterable<Row[]>;
}

/**
 * GET /api/reports/<key>.csv — checks access, works out the rows, writes the audit row, and
 * returns the file pieces for the controller to stream. `db`: the report connection, or a
 * caller's transaction (checks that roll back; the audit row then goes into it too).
 */
export async function startReportDownload<K extends ReportKey>(
  me: AuthUser,
  scope: PermissionScope,
  key: K,
  query: ReportQuery[K],
  db: Db = reportsDb
): Promise<ReportDownload> {
  assertMayDownload(me, key);
  const zoneId = zoneFor(me, scope, query.zoneId);
  const dates = datesFor(key, query);
  const range =
    dates.from && dates.to
      ? {
          gte: istMidnight(dates.from),
          lt: new Date(istMidnight(dates.to).getTime() + DAY_MS),
        }
      : null;
  const cutoff = dormantCutoff(await getSetting("partners.dormant_days"));
  const ctx: ReportContext = { db, zoneId, range, cutoff };

  let output: ReportOutput;
  switch (key) {
    case "scans":
      output = await scansReport(ctx, query as ReportQuery["scans"]);
      break;
    case "points-issued":
      output = await pointsIssuedReport(ctx);
      break;
    case "payouts":
      output = await payoutsReport(ctx, query as ReportQuery["payouts"]);
      break;
    case "partners":
      output = await partnersReport(ctx, query as ReportQuery["partners"]);
      break;
    case "products":
      output = await productsReport(ctx);
      break;
    case "regions":
      output = await regionsReport(ctx);
      break;
    case "tasks":
      output = await tasksReport(ctx, query as ReportQuery["tasks"]);
      break;
    case "requests":
      output = await requestsReport(ctx, query as ReportQuery["requests"]);
      break;
    default:
      throw new Error(`Unknown report ${String(key)}`);
  }

  // One audit row per download, before anything is sent (DEC-218). Written on the main
  // connection (the report connection may be a read-only copy).
  const filters = {
    ...query,
    from: dates.from,
    to: dates.to,
    zoneId: zoneId === NO_ZONE ? null : (zoneId ?? null),
  };
  const writeAudit = (tx: Db) =>
    recordAudit(tx, {
      actorId: me.id,
      action: "report.export",
      entity: { type: "report", id: key },
      after: { report: key, filters, rowCount: output.rowCount },
    });
  if (db === reportsDb) {
    await prisma.$transaction((tx) => writeAudit(tx));
  } else {
    await writeAudit(db);
  }

  const filename = dates.from
    ? `${key}_${dates.from}_to_${dates.to}.csv`
    : `${key}_${todayInIst()}.csv`;
  return { filename, header: output.header, rowCount: output.rowCount, batches: output.batches };
}

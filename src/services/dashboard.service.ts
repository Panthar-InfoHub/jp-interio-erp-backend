import { ROLE, ROLES } from "../config/roles.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { SubAdminArea } from "../generated/prisma/enums.js";
import { reportsDb } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { ForbiddenError } from "../utils/errors.js";
import { dateFromIso, isoFromDate, todayInIst } from "../utils/istDate.js";
import { pointsToRupees } from "../utils/money.js";
import { dormantCutoff, periodRange, type Period, type PeriodRange } from "../utils/period.js";
import type { AsmRanking } from "../validators/dashboard.schema.js";
import { OPEN_REQUEST_WHERE } from "./request.service.js";
import { scopeForPartners } from "./scope.service.js";
import { getSetting } from "./settings.service.js";
import { UNFINISHED } from "./task.service.js";

/**
 * Dashboards (Module 16; DEC-195 – DEC-221). One address for everyone: `GET /dashboard`
 * (DEC-220). The server looks at who is asking and returns only their cards.
 * - T2: Admin (whole company) and Sub-Admin (the cards of the areas they hold).
 * - T3: Zonal Head (their zone, ASM performance table) and the leaderboards (Admin + Zonal
 *   Head, DEC-217, DEC-222). T4: ASM and Sales Executive (mobile app, DEC-223).
 * Numbers are counted live on every call (DEC-211) through the report connection
 * (`reportsDb`, DEC-210). Period cards follow `?period=` (DEC-202); "now" cards show the
 * current state whatever the period. What every number means: DEC-221.
 */

type Db = Prisma.TransactionClient;

/** The "count only things inside the period" filter for one date column. */
function inPeriod(range: PeriodRange): Prisma.DateTimeFilter {
  return range.from ? { gte: range.from, lte: range.to } : { lte: range.to };
}

/** Decimal sum (or null) → "1234.00". */
function rupees(value: Prisma.Decimal | null | undefined): string {
  return value ? value.toFixed(2) : "0.00";
}

// ---------------------------------------------------------------------------
// Card groups. Each takes the filters that keep it inside the viewer's part of the
// business, so T3 / T4 can reuse them for a zone or a team.
// ---------------------------------------------------------------------------

/**
 * Partners who finished sign-up (DEC-221): sent for approval at least once, so their KYC is
 * pending, verified or rejected (never back to `not_submitted`), and not a retired draft.
 * Read from `kyc_state` rather than `onboarding_step` so partners made by the dev-data
 * script (which sets the KYC state directly) count too.
 */
const SIGNED_UP: Prisma.UserWhereInput = {
  roleId: ROLE.PARTNER,
  partnerProfile: { is: { kycState: { not: "not_submitted" }, draftRemovedAt: null } },
};

/**
 * Partners: total, KYC pending, active / dormant (DEC-201, DEC-221), suspended (now), and
 * new partners (finished sign-up in the period).
 */
async function partnerCards(
  db: Db,
  range: PeriodRange,
  cutoff: Date,
  scope: Prisma.UserWhereInput
) {
  const base: Prisma.UserWhereInput = { AND: [SIGNED_UP, scope] };
  // Active / dormant are counted among verified partners who are not suspended or switched off.
  const live: Prisma.UserWhereInput = {
    AND: [base, { status: "active", partnerProfile: { is: { kycState: "verified" } } }],
  };
  const scannedRecently: Prisma.UserWhereInput = {
    scans: { some: { scannedAt: { gte: cutoff } } },
  };

  const [total, kycPending, active, dormant, suspended, newInPeriod] = await Promise.all([
    db.user.count({ where: base }),
    db.user.count({ where: { AND: [base, { partnerProfile: { is: { kycState: "pending" } } }] } }),
    db.user.count({ where: { AND: [live, scannedRecently] } }),
    db.user.count({ where: { AND: [live, { NOT: scannedRecently }] } }),
    db.user.count({ where: { AND: [base, { status: "suspended" }] } }),
    // All time = every signed-up partner (no date needed).
    range.from
      ? db.user.count({
          where: { AND: [base, { partnerProfile: { is: { submittedAt: inPeriod(range) } } }] },
        })
      : db.user.count({ where: base }),
  ]);
  return { total, kycPending, active, dormant, suspended, newInPeriod };
}

/** Scans in the period and the points they gave (= the `earn` lines; scans only, DEC-221). */
async function scanCards(db: Db, range: PeriodRange, scope: Prisma.ScanWhereInput) {
  const result = await db.scan.aggregate({
    where: { AND: [scope, { scannedAt: inPeriod(range) }] },
    _count: { _all: true },
    _sum: { points: true },
  });
  const points = result._sum.points ?? 0;
  return {
    scans: result._count._all,
    pointsIssued: points,
    pointsIssuedRupees: pointsToRupees(points),
  };
}

/** Points partners hold that may still be cashed out, now (available + held of every wallet). */
async function liabilityCard(db: Db, scope: Prisma.WalletWhereInput) {
  const result = await db.wallet.aggregate({
    where: scope,
    _sum: { available: true, held: true },
  });
  const available = result._sum.available ?? 0;
  const held = result._sum.held ?? 0;
  const owed = available + held;
  return { available, held, owed, owedRupees: pointsToRupees(owed) };
}

/**
 * Payouts: waiting for approval and approved-not-paid (now); paid (by the date marked paid,
 * DEC-221) and failed (by the date marked failed) in the period. Count and rupees.
 */
async function payoutCards(db: Db, range: PeriodRange, scope: Prisma.PayoutWhereInput) {
  const sum = (where: Prisma.PayoutWhereInput) =>
    db.payout.aggregate({
      where: { AND: [scope, where] },
      _count: { _all: true },
      _sum: { amount: true },
    });
  const [waiting, approved, paid, failed] = await Promise.all([
    sum({ status: "requested" }),
    sum({ status: "approved" }),
    sum({ status: "paid", paidAt: inPeriod(range) }),
    sum({ status: "failed", failedAt: inPeriod(range) }),
  ]);
  const card = (row: typeof waiting) => ({
    count: row._count._all,
    amount: rupees(row._sum.amount),
  });
  return {
    waitingApproval: card(waiting),
    approvedNotPaid: card(approved),
    paidInPeriod: card(paid),
    failedInPeriod: card(failed),
  };
}

/** Request stages that count as open (DEC-161), in display order. */
const OPEN_STAGES = [
  "requested",
  "accepted",
  "payment_received",
  "processing",
  "dispatched",
  "delivered",
  "cancelled",
  "refund_initiated",
] as const;

/**
 * Requests: open per stage + pipeline value (now; DEC-196: sum of open requests' agreed
 * prices, samples have none); delivered in the period (reached delivered or completed,
 * DEC-221); refunds waiting (now: cancelled after money was received, or refund started).
 */
async function requestCards(db: Db, range: PeriodRange, scope: Prisma.PartnerRequestWhereInput) {
  const open: Prisma.PartnerRequestWhereInput = { AND: [scope, OPEN_REQUEST_WHERE] };
  const [byStage, pipeline, delivered, refundsWaiting] = await Promise.all([
    db.partnerRequest.groupBy({ by: ["status"], where: open, _count: { _all: true } }),
    db.partnerRequest.aggregate({ where: open, _sum: { agreedAmount: true } }),
    db.partnerRequest.count({
      where: {
        AND: [
          scope,
          {
            events: {
              some: { toStatus: { in: ["delivered", "completed"] }, createdAt: inPeriod(range) },
            },
          },
        ],
      },
    }),
    db.partnerRequest.count({
      where: {
        AND: [
          scope,
          {
            OR: [
              { status: "cancelled", paymentDate: { not: null } },
              { status: "refund_initiated" },
            ],
          },
        ],
      },
    }),
  ]);
  const counts = new Map(byStage.map((row) => [row.status, row._count._all]));
  const openByStage = Object.fromEntries(
    OPEN_STAGES.map((stage) => [stage, counts.get(stage) ?? 0])
  );
  return {
    open: byStage.reduce((sum, row) => sum + row._count._all, 0),
    /** `cancelled` here = cancelled after money was received, refund not started. */
    openByStage,
    pipelineValue: rupees(pipeline._sum.agreedAmount),
    deliveredInPeriod: delivered,
    refundsWaiting,
  };
}

/** Tasks: open and overdue (now, India date), completed in the period. */
async function taskCards(db: Db, range: PeriodRange, scope: Prisma.TaskWhereInput) {
  const today = dateFromIso(todayInIst());
  const [open, overdue, completed] = await Promise.all([
    db.task.count({ where: { AND: [scope, UNFINISHED] } }),
    db.task.count({ where: { AND: [scope, UNFINISHED, { dueDate: { lt: today } }] } }),
    db.task.count({
      where: { AND: [scope, { status: "completed", completedAt: inPeriod(range) }] },
    }),
  ]);
  return { open, overdue, completedInPeriod: completed };
}

/** Tasks this person gave to others that are still open, and of those overdue (now). */
async function tasksGivenCards(db: Db, giverId: string) {
  const today = dateFromIso(todayInIst());
  const given: Prisma.TaskWhereInput = { AND: [UNFINISHED, { assignedById: giverId }] };
  const [open, overdue] = await Promise.all([
    db.task.count({ where: given }),
    db.task.count({ where: { AND: [given, { dueDate: { lt: today } }] } }),
  ]);
  return { open, overdue };
}

/** Support tickets not finished yet (now). Admin only (DEC-188). */
async function ticketCards(db: Db) {
  const rows = await db.supportTicket.groupBy({
    by: ["status"],
    where: { status: { in: ["open", "in_progress"] } },
    _count: { _all: true },
  });
  const counts = new Map(rows.map((row) => [row.status, row._count._all]));
  return { open: counts.get("open") ?? 0, inProgress: counts.get("in_progress") ?? 0 };
}

/** Active staff per role (DEC-221), every role key present. */
async function staffCards(db: Db) {
  const rows = await db.user.groupBy({
    by: ["roleId"],
    where: { roleId: { not: ROLE.PARTNER }, status: "active" },
    _count: { _all: true },
  });
  const counts = new Map(rows.map((row) => [row.roleId, row._count._all]));
  const byRole = Object.fromEntries(
    ROLES.filter((role) => role.id !== ROLE.PARTNER).map((role) => [
      role.key,
      counts.get(role.id) ?? 0,
    ])
  );
  return { total: rows.reduce((sum, row) => sum + row._count._all, 0), byRole };
}

/** Manual point changes in the period (Rewards): how many, points added, points taken. */
async function manualPointCards(db: Db, range: PeriodRange) {
  const rows = await db.rewardsLedgerEntry.groupBy({
    by: ["direction"],
    where: { type: "adjust", createdAt: inPeriod(range) },
    _count: { _all: true },
    _sum: { points: true },
  });
  const credit = rows.find((row) => row.direction === "credit");
  const debit = rows.find((row) => row.direction === "debit");
  return {
    count: (credit?._count._all ?? 0) + (debit?._count._all ?? 0),
    pointsAdded: credit?._sum.points ?? 0,
    pointsTaken: debit?._sum.points ?? 0,
  };
}

const TOP_PRODUCTS = 5;

/** Products: active / inactive (now) and the top 5 by scans in the period (DEC-221). */
async function productCards(db: Db, range: PeriodRange) {
  const [active, inactive, top] = await Promise.all([
    db.product.count({ where: { active: true } }),
    db.product.count({ where: { active: false } }),
    db.scan.groupBy({
      by: ["productId"],
      where: { scannedAt: inPeriod(range) },
      _count: { _all: true },
      _sum: { points: true },
      orderBy: [{ _count: { productId: "desc" } }, { productId: "asc" }],
      take: TOP_PRODUCTS,
    }),
  ]);
  const products = await db.product.findMany({
    where: { id: { in: top.map((row) => row.productId) } },
    select: { id: true, sku: true, name: true, active: true },
  });
  const byId = new Map(products.map((product) => [product.id, product]));
  return {
    active,
    inactive,
    topByScans: top.map((row, index) => ({
      rank: index + 1,
      product: byId.get(row.productId) ?? null,
      scans: row._count._all,
      points: row._sum.points ?? 0,
    })),
  };
}

/**
 * QR: batches made in the period (and how many of them are voided now), and the codes in
 * those batches by their CURRENT state (DEC-221). "Printed" = codes in a batch downloaded
 * for printing at least once.
 */
async function qrCards(db: Db, range: PeriodRange) {
  const batchWhere: Prisma.QrBatchWhereInput = { createdAt: inPeriod(range) };
  const [batches, voided, codes, printed] = await Promise.all([
    db.qrBatch.count({ where: batchWhere }),
    db.qrBatch.count({ where: { AND: [batchWhere, { status: "voided" }] } }),
    db.qrCode.groupBy({ by: ["status"], where: { batch: batchWhere }, _count: { _all: true } }),
    db.qrCode.count({
      where: { batch: { AND: [batchWhere, { firstExportedAt: { not: null } }] } },
    }),
  ]);
  const counts = new Map(codes.map((row) => [row.status, row._count._all]));
  return {
    batchesMade: batches,
    batchesVoided: voided,
    codes: {
      total: codes.reduce((sum, row) => sum + row._count._all, 0),
      printed,
      scanned: counts.get("scanned") ?? 0,
      notScanned: counts.get("active") ?? 0,
      void: counts.get("void") ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Leaderboards (T3, DEC-217, DEC-222): top 5, Admin (all) and Zonal Head (zone).
// ---------------------------------------------------------------------------

const LEADERBOARD_SIZE = 5;
/** Rows read before the final sort, so the name tie-break (DEC-222) sees every close tie. */
const LEADERBOARD_READ = 20;

/** Matches nothing (a Zonal Head without a zone). */
const NO_ZONE = "00000000-0000-0000-0000-000000000000";

/** Higher value first; then whoever reached it first; then by name (DEC-222). */
function rankRows<T extends { value: number; reachedAt: Date | null; name: string | null }>(
  rows: T[]
) {
  return rows
    .filter((row) => row.value > 0)
    .sort(
      (a, b) =>
        b.value - a.value ||
        (a.reachedAt?.getTime() ?? Infinity) - (b.reachedAt?.getTime() ?? Infinity) ||
        (a.name ?? "").localeCompare(b.name ?? "")
    )
    .slice(0, LEADERBOARD_SIZE)
    .map((row, index) => ({ rank: index + 1, ...row }));
}

/**
 * Top partners by points earned from scans in the period. `zoneId` = only scans made in
 * that zone (where they happened, DEC-222); null = whole company.
 */
async function topPartners(db: Db, range: PeriodRange, zoneId: string | null | undefined) {
  const rows = await db.scan.groupBy({
    by: ["partnerId"],
    where: {
      scannedAt: inPeriod(range),
      ...(zoneId !== undefined && { zoneId: zoneId ?? NO_ZONE }),
    },
    _sum: { points: true },
    _count: { _all: true },
    _max: { scannedAt: true },
    orderBy: [{ _sum: { points: "desc" } }, { _max: { scannedAt: "asc" } }],
    take: LEADERBOARD_READ,
  });
  const people = await db.user.findMany({
    where: { id: { in: rows.map((row) => row.partnerId) } },
    select: {
      id: true,
      name: true,
      zone: { select: { id: true, name: true } },
      partnerProfile: { select: { businessName: true, partnerType: true } },
    },
  });
  const byId = new Map(people.map((person) => [person.id, person]));
  return rankRows(
    rows.map((row) => {
      const person = byId.get(row.partnerId);
      return {
        partner: {
          id: row.partnerId,
          name: person?.name ?? null,
          businessName: person?.partnerProfile?.businessName ?? null,
          partnerType: person?.partnerProfile?.partnerType ?? null,
          zone: person?.zone ?? null,
        },
        name: person?.name ?? null,
        value: row._sum.points ?? 0,
        scans: row._count._all,
        reachedAt: row._max.scannedAt,
      };
    })
  ).map(({ name: _name, reachedAt: _reachedAt, value, ...row }) => ({ ...row, points: value }));
}

/** Active ASMs (DEC-222), optionally only those in one zone. */
function activeAsms(zoneId: string | null | undefined): Prisma.UserWhereInput {
  return {
    roleId: ROLE.ASM,
    status: "active",
    ...(zoneId !== undefined && { zoneId: zoneId ?? NO_ZONE }),
  };
}

/**
 * Top active ASMs by points or scans of their partners (owning ASM at scan time, DEC-222),
 * or by new partners (partners they own now who finished sign-up in the period).
 */
async function topAsms(
  db: Db,
  range: PeriodRange,
  zoneId: string | null | undefined,
  rankBy: AsmRanking
) {
  const asmWhere = activeAsms(zoneId);
  let rows: { asmId: string; value: number; reachedAt: Date | null }[];

  if (rankBy === "newPartners") {
    const grouped = await db.user.groupBy({
      by: ["parentId"],
      where: {
        AND: [
          SIGNED_UP,
          { parent: { is: asmWhere } },
          ...(range.from ? [{ partnerProfile: { is: { submittedAt: inPeriod(range) } } }] : []),
        ],
      },
      _count: { _all: true },
    });
    rows = grouped
      .filter((row) => row.parentId)
      .map((row) => ({ asmId: row.parentId!, value: row._count._all, reachedAt: null }));
  } else {
    const grouped = await db.scan.groupBy({
      by: ["owningAsmId"],
      where: { scannedAt: inPeriod(range), owningAsm: { is: asmWhere } },
      _sum: { points: true },
      _count: { _all: true },
      _max: { scannedAt: true },
    });
    rows = grouped
      .filter((row) => row.owningAsmId)
      .map((row) => ({
        asmId: row.owningAsmId!,
        value: rankBy === "points" ? (row._sum.points ?? 0) : row._count._all,
        reachedAt: row._max.scannedAt,
      }));
  }

  const asms = await db.user.findMany({
    where: { id: { in: rows.map((row) => row.asmId) } },
    select: { id: true, name: true, zone: { select: { id: true, name: true } } },
  });
  const byId = new Map(asms.map((asm) => [asm.id, asm]));
  return {
    rankedBy: rankBy,
    items: rankRows(
      rows.map((row) => ({
        asm: {
          id: row.asmId,
          name: byId.get(row.asmId)?.name ?? null,
          zone: byId.get(row.asmId)?.zone ?? null,
        },
        name: byId.get(row.asmId)?.name ?? null,
        value: row.value,
        reachedAt: row.reachedAt,
      }))
    ).map(({ name: _name, reachedAt: _reachedAt, ...row }) => row),
  };
}

async function leaderboards(
  db: Db,
  range: PeriodRange,
  zoneId: string | null | undefined,
  rankAsmsBy: AsmRanking
) {
  const [partners, asms] = await Promise.all([
    topPartners(db, range, zoneId),
    topAsms(db, range, zoneId, rankAsmsBy),
  ]);
  return { topPartners: partners, topAsms: asms };
}

// ---------------------------------------------------------------------------
// ASM performance table (T3, DEC-212, DEC-222): one row per active ASM in the zone.
// ---------------------------------------------------------------------------

async function asmPerformance(db: Db, range: PeriodRange, cutoff: Date, zoneId: string | null) {
  const asms = await db.user.findMany({
    where: activeAsms(zoneId),
    select: { id: true, name: true, phone: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  if (asms.length === 0) return [];
  const asmIds = asms.map((asm) => asm.id);

  // Every Sales Executive under these ASMs (any status) for task counts; active ones are counted.
  const salesExecs = await db.user.findMany({
    where: { roleId: ROLE.SALES_EXECUTIVE, parentId: { in: asmIds } },
    select: { id: true, parentId: true, status: true },
  });
  /** Task doer → their ASM (the ASM themselves, or a Sales Executive's ASM). */
  const teamOf = new Map<string, string>(asmIds.map((id) => [id, id]));
  for (const se of salesExecs) if (se.parentId) teamOf.set(se.id, se.parentId);
  const teamIds = [...teamOf.keys()];

  const ownedBy: Prisma.UserWhereInput = { AND: [SIGNED_UP, { parentId: { in: asmIds } }] };
  const live: Prisma.UserWhereInput = {
    AND: [ownedBy, { status: "active", partnerProfile: { is: { kycState: "verified" } } }],
  };
  const scannedRecently: Prisma.UserWhereInput = {
    scans: { some: { scannedAt: { gte: cutoff } } },
  };
  const today = dateFromIso(todayInIst());
  const openRequests: Prisma.PartnerRequestWhereInput = {
    AND: [OPEN_REQUEST_WHERE, { owningAsmId: { in: asmIds } }],
  };

  const [onboarded, active, dormant, scans, open, delivered, overdue, completed] =
    await Promise.all([
      db.user.groupBy({
        by: ["parentId"],
        where: {
          AND: [
            ownedBy,
            ...(range.from ? [{ partnerProfile: { is: { submittedAt: inPeriod(range) } } }] : []),
          ],
        },
        _count: { _all: true },
      }),
      db.user.groupBy({
        by: ["parentId"],
        where: { AND: [live, scannedRecently] },
        _count: { _all: true },
      }),
      db.user.groupBy({
        by: ["parentId"],
        where: { AND: [live, { NOT: scannedRecently }] },
        _count: { _all: true },
      }),
      db.scan.groupBy({
        by: ["owningAsmId"],
        where: { owningAsmId: { in: asmIds }, scannedAt: inPeriod(range) },
        _count: { _all: true },
        _sum: { points: true },
      }),
      db.partnerRequest.groupBy({
        by: ["owningAsmId"],
        where: openRequests,
        _count: { _all: true },
        _sum: { agreedAmount: true },
      }),
      db.partnerRequest.groupBy({
        by: ["owningAsmId"],
        where: {
          owningAsmId: { in: asmIds },
          events: {
            some: { toStatus: { in: ["delivered", "completed"] }, createdAt: inPeriod(range) },
          },
        },
        _count: { _all: true },
      }),
      db.task.groupBy({
        by: ["assignedToId"],
        where: { AND: [UNFINISHED, { assignedToId: { in: teamIds } }, { dueDate: { lt: today } }] },
        _count: { _all: true },
      }),
      db.task.findMany({
        where: {
          assignedToId: { in: teamIds },
          status: "completed",
          completedAt: inPeriod(range),
        },
        select: { assignedToId: true, completedAt: true, dueDate: true },
      }),
    ]);

  const countBy = <K extends string>(
    rows: ({ _count: { _all: number } } & Record<K, string | null>)[],
    key: K
  ) => new Map(rows.map((row) => [row[key], row._count._all]));
  const onboardedBy = countBy(onboarded, "parentId");
  const activeBy = countBy(active, "parentId");
  const dormantBy = countBy(dormant, "parentId");
  const scansBy = new Map(scans.map((row) => [row.owningAsmId, row]));
  const openBy = new Map(open.map((row) => [row.owningAsmId, row]));
  const deliveredBy = countBy(delivered, "owningAsmId");

  const tasks = new Map(asmIds.map((id) => [id, { completed: 0, onTime: 0, overdue: 0 }]));
  for (const row of overdue) {
    const team = tasks.get(teamOf.get(row.assignedToId) ?? "");
    if (team) team.overdue += row._count._all;
  }
  for (const row of completed) {
    const team = tasks.get(teamOf.get(row.assignedToId) ?? "");
    if (!team) continue;
    team.completed += 1;
    // On time = completed on or before the due day, India date (DEC-222).
    if (row.completedAt && todayInIst(row.completedAt) <= (isoFromDate(row.dueDate) ?? "")) {
      team.onTime += 1;
    }
  }

  return asms.map((asm) => {
    const scan = scansBy.get(asm.id);
    const req = openBy.get(asm.id);
    const points = scan?._sum.points ?? 0;
    return {
      asm,
      partnersOnboarded: onboardedBy.get(asm.id) ?? 0,
      activePartners: activeBy.get(asm.id) ?? 0,
      dormantPartners: dormantBy.get(asm.id) ?? 0,
      scans: scan?._count._all ?? 0,
      points,
      pointsRupees: pointsToRupees(points),
      requests: {
        open: req?._count._all ?? 0,
        deliveredInPeriod: deliveredBy.get(asm.id) ?? 0,
        pipelineValue: rupees(req?._sum.agreedAmount),
      },
      tasks: tasks.get(asm.id)!,
      salesExecutives: salesExecs.filter((se) => se.parentId === asm.id && se.status === "active")
        .length,
    };
  });
}

// ---------------------------------------------------------------------------
// Dashboards per role
// ---------------------------------------------------------------------------

/** Admin: the whole company (DEC-216) + leaderboards (DEC-217). Fraud flags: Module 17. */
async function adminDashboard(db: Db, range: PeriodRange, cutoff: Date, rankAsmsBy: AsmRanking) {
  const [staff, partners, scans, liability, payouts, requests, tasks, tickets, boards] =
    await Promise.all([
      staffCards(db),
      partnerCards(db, range, cutoff, {}),
      scanCards(db, range, {}),
      liabilityCard(db, {}),
      payoutCards(db, range, {}),
      requestCards(db, range, {}),
      taskCards(db, range, {}),
      ticketCards(db),
      leaderboards(db, range, undefined, rankAsmsBy),
    ]);
  return {
    staff,
    partners,
    scans,
    pointsLiability: liability,
    payouts,
    requests,
    tasks,
    tickets,
    leaderboards: boards,
  };
}

/**
 * Zonal Head: their one zone (DEC-216, DEC-222). Activity (scans, points, requests) counts
 * where it happened (zone saved on the record); partners and the payout queue follow the
 * partner's current zone. A Zonal Head without a zone sees zeros.
 */
async function zonalHeadDashboard(
  db: Db,
  me: AuthUser,
  range: PeriodRange,
  cutoff: Date,
  rankAsmsBy: AsmRanking
) {
  const zoneId = me.zoneId;
  const zone = zoneId ?? NO_ZONE;
  const [partners, scans, payouts, requests, zoneTasks, myTasks, performance, boards] =
    await Promise.all([
      partnerCards(db, range, cutoff, scopeForPartners(me, "scoped")),
      scanCards(db, range, { zoneId: zone }),
      payoutCards(db, range, { partner: scopeForPartners(me, "scoped") }),
      requestCards(db, range, { zoneId: zone }),
      taskCards(db, range, { zoneId: zone }),
      taskCards(db, range, { assignedToId: me.id }),
      asmPerformance(db, range, cutoff, zoneId),
      leaderboards(db, range, zoneId, rankAsmsBy),
    ]);
  return {
    partners,
    scans,
    payouts: { toApprove: payouts.waitingApproval, toPay: payouts.approvedNotPaid },
    requests,
    tasks: { zone: zoneTasks, mine: myTasks },
    asmPerformance: performance,
    leaderboards: boards,
  };
}

/**
 * A person's own unfinished tasks (T4, DEC-223): due today, overdue (due day passed) and
 * all unfinished. India dates.
 */
async function myTaskCards(db: Db, userId: string) {
  const today = dateFromIso(todayInIst());
  const mine: Prisma.TaskWhereInput = { AND: [UNFINISHED, { assignedToId: userId }] };
  const [dueToday, overdue, allUnfinished] = await Promise.all([
    db.task.count({ where: { AND: [mine, { dueDate: today }] } }),
    db.task.count({ where: { AND: [mine, { dueDate: { lt: today } }] } }),
    db.task.count({ where: mine }),
  ]);
  return { dueToday, overdue, allUnfinished };
}

/**
 * One row per active Sales Executive under the ASM (DEC-223):
 * partners they signed up in the field (finished sign-up in the period), partners assigned
 * now, open requests they handle now, tasks completed in the period + overdue now, and
 * requests they moved to delivered or completed in the period.
 */
async function salesExecSummary(db: Db, range: PeriodRange, asmId: string) {
  const salesExecs = await db.user.findMany({
    where: { roleId: ROLE.SALES_EXECUTIVE, parentId: asmId, status: "active" },
    select: { id: true, name: true, phone: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  if (salesExecs.length === 0) return [];
  const ids = salesExecs.map((se) => se.id);
  const signedUp: Prisma.PartnerProfileWhereInput = {
    kycState: { not: "not_submitted" },
    draftRemovedAt: null,
    user: { roleId: ROLE.PARTNER },
  };
  const today = dateFromIso(todayInIst());

  const [onboarded, assigned, openRequests, completed, overdue, handled] = await Promise.all([
    db.partnerProfile.groupBy({
      by: ["onboardedById"],
      where: {
        AND: [
          signedUp,
          { onboardedById: { in: ids } },
          ...(range.from ? [{ submittedAt: inPeriod(range) }] : []),
        ],
      },
      _count: { _all: true },
    }),
    db.partnerProfile.groupBy({
      by: ["salesExecutiveId"],
      where: { AND: [signedUp, { salesExecutiveId: { in: ids } }] },
      _count: { _all: true },
    }),
    db.partnerRequest.groupBy({
      by: ["handlerId"],
      where: { AND: [OPEN_REQUEST_WHERE, { handlerId: { in: ids } }] },
      _count: { _all: true },
    }),
    db.task.groupBy({
      by: ["assignedToId"],
      where: { assignedToId: { in: ids }, status: "completed", completedAt: inPeriod(range) },
      _count: { _all: true },
    }),
    db.task.groupBy({
      by: ["assignedToId"],
      where: { AND: [UNFINISHED, { assignedToId: { in: ids } }, { dueDate: { lt: today } }] },
      _count: { _all: true },
    }),
    // One row per (SE, request), so a request moved to delivered and then completed counts once.
    db.partnerRequestEvent.groupBy({
      by: ["actorId", "requestId"],
      where: {
        actorId: { in: ids },
        toStatus: { in: ["delivered", "completed"] },
        createdAt: inPeriod(range),
      },
    }),
  ]);

  const count = (rows: { _count: { _all: number } }[], key: (row: any) => string | null) =>
    new Map(rows.map((row) => [key(row), row._count._all]));
  const onboardedBy = count(onboarded, (row) => row.onboardedById);
  const assignedTo = count(assigned, (row) => row.salesExecutiveId);
  const openBy = count(openRequests, (row) => row.handlerId);
  const completedBy = count(completed, (row) => row.assignedToId);
  const overdueBy = count(overdue, (row) => row.assignedToId);
  const handledBy = new Map<string, number>();
  for (const row of handled) handledBy.set(row.actorId, (handledBy.get(row.actorId) ?? 0) + 1);

  return salesExecs.map((se) => ({
    salesExecutive: se,
    partnersOnboarded: onboardedBy.get(se.id) ?? 0,
    assignedPartners: assignedTo.get(se.id) ?? 0,
    openRequests: openBy.get(se.id) ?? 0,
    tasks: { completedInPeriod: completedBy.get(se.id) ?? 0, overdue: overdueBy.get(se.id) ?? 0 },
    requestsHandled: handledBy.get(se.id) ?? 0,
  }));
}

/**
 * ASM (mobile app, DEC-204, DEC-216, DEC-223): own tasks; partners they own now (incl. those
 * assigned to their SEs); scans / points by the ASM saved on the scan (DEC-222); open
 * requests they handle personally + the team's requests (owning ASM) with pipeline value;
 * one summary row per active Sales Executive.
 */
async function asmDashboard(db: Db, me: AuthUser, range: PeriodRange, cutoff: Date) {
  const [tasks, partners, scans, team, handledByMe, salesExecutives] = await Promise.all([
    myTaskCards(db, me.id),
    partnerCards(db, range, cutoff, scopeForPartners(me, "own")),
    scanCards(db, range, { owningAsmId: me.id }),
    requestCards(db, range, { owningAsmId: me.id }),
    db.partnerRequest.count({ where: { AND: [OPEN_REQUEST_WHERE, { handlerId: me.id }] } }),
    salesExecSummary(db, range, me.id),
  ]);
  return {
    tasks,
    partners,
    scans,
    requests: { waitingOnMe: handledByMe, team },
    salesExecutives,
  };
}

/**
 * Sales Executive (mobile app, DEC-204, DEC-216, DEC-223): own tasks; partners assigned to
 * them now; scans / points by those partners (assigned now, since scans don't save the SE);
 * their open requests (they are the handler).
 */
async function salesExecDashboard(db: Db, me: AuthUser, range: PeriodRange, cutoff: Date) {
  const [tasks, partners, scans, requests] = await Promise.all([
    myTaskCards(db, me.id),
    partnerCards(db, range, cutoff, scopeForPartners(me, "own")),
    scanCards(db, range, { partner: { partnerProfile: { is: { salesExecutiveId: me.id } } } }),
    requestCards(db, range, { handlerId: me.id }),
  ]);
  return { tasks, partners, scans, requests };
}

/** The order the areas are returned in. */
const AREA_ORDER: readonly SubAdminArea[] = [
  "partners",
  "rewards",
  "products",
  "qr",
  "tasks",
  "requests",
];

/** One Sub-Admin area's cards (DEC-216). Sub-Admins work across all zones. */
async function areaCards(
  db: Db,
  me: AuthUser,
  area: SubAdminArea,
  range: PeriodRange,
  cutoff: Date
) {
  switch (area) {
    case "partners":
      return partnerCards(db, range, cutoff, {});
    case "rewards": {
      const [payouts, scans, liability, manualChanges] = await Promise.all([
        payoutCards(db, range, {}),
        scanCards(db, range, {}),
        liabilityCard(db, {}),
        manualPointCards(db, range),
      ]);
      return {
        payouts,
        pointsIssued: scans.pointsIssued,
        pointsIssuedRupees: scans.pointsIssuedRupees,
        pointsLiability: liability,
        manualChanges,
      };
    }
    case "products":
      return productCards(db, range);
    case "qr":
      return qrCards(db, range);
    case "tasks": {
      const [tasks, givenByMe] = await Promise.all([
        taskCards(db, range, {}),
        tasksGivenCards(db, me.id),
      ]);
      return { ...tasks, givenByMe };
    }
    case "requests":
      return requestCards(db, range, {});
  }
}

async function subAdminDashboard(db: Db, me: AuthUser, range: PeriodRange, cutoff: Date) {
  const areas = AREA_ORDER.filter((area) => me.subAdminAreas.includes(area));
  const cards = await Promise.all(areas.map((area) => areaCards(db, me, area, range, cutoff)));
  return { areas, cards: Object.fromEntries(areas.map((area, index) => [area, cards[index]])) };
}

/**
 * GET /dashboard — the caller's dashboard (DEC-220). `db`: the report connection, or a
 * caller's transaction (checks that roll back).
 */
export async function getDashboard(
  me: AuthUser,
  options: { period: Period; rankAsmsBy: AsmRanking },
  db: Db = reportsDb
) {
  const now = new Date();
  const range = periodRange(options.period, now);
  const dormantDays = await getSetting("partners.dormant_days");
  const cutoff = dormantCutoff(dormantDays, now);

  const head = {
    role: me.roleKey,
    period: { key: range.period, from: range.from, to: range.to },
    dormantDays,
  };

  switch (me.roleId) {
    case ROLE.ADMIN:
      return { ...head, cards: await adminDashboard(db, range, cutoff, options.rankAsmsBy) };
    case ROLE.SUB_ADMIN:
      return { ...head, ...(await subAdminDashboard(db, me, range, cutoff)) };
    case ROLE.ZONAL_HEAD:
      return {
        ...head,
        zoneId: me.zoneId,
        cards: await zonalHeadDashboard(db, me, range, cutoff, options.rankAsmsBy),
      };
    case ROLE.ASM:
      return { ...head, cards: await asmDashboard(db, me, range, cutoff) };
    case ROLE.SALES_EXECUTIVE:
      return { ...head, cards: await salesExecDashboard(db, me, range, cutoff) };
    default:
      // Partners have no `dashboard.view` (DEC-197); the route refuses them first.
      throw new ForbiddenError();
  }
}

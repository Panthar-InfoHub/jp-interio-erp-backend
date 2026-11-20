import type {
  LedgerDirection,
  LedgerEntryType,
  Prisma,
  RewardsLedgerEntry,
} from "../generated/prisma/client.js";
import type { PermissionScope } from "../generated/prisma/enums.js";
import { ROLE } from "../config/roles.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { AppError } from "../utils/errors.js";
import { pointsToRupees } from "../utils/money.js";
import { pageMeta, toPrismaOrderBy, toPrismaPaging } from "../utils/pagination.js";
import type { LedgerQuery, StatementQuery } from "../validators/wallet.schema.js";
import { recordAudit } from "./audit.service.js";
import { isWalletFrozen } from "./ledger.service.js";
import { getPermissionScope } from "./permission.service.js";
import { assertInScope, scopeForPartners } from "./scope.service.js";

/**
 * Wallets (Module 8). A wallet is opened empty (all zeros); points only ever change
 * through the ledger service (`postLedgerEntry`, ledger.service.ts).
 *
 * Opened (DEC-132):
 * - at KYC approval, inside the approval transaction (kyc.service.ts);
 * - by `npm run db:seed` for partners verified before Module 8 (DEC-129);
 * - by `npm run db:dev-data` for its verified test partners.
 * Suspended / deactivated partners get one too; it is simply frozen (DEC-131).
 *
 * Read by the partner (T4: own wallet only, no partner id in the address) and by staff
 * (T5: `ledger.view` within scope). Both use the same code below (DEC-134).
 */

/**
 * Opens an empty wallet for the partner if they have none. Returns true if one was
 * opened now, false if it already existed (left as it is). Safe to call twice.
 * Writes no audit entry; the caller records it (DEC-132).
 */
export async function openWallet(
  tx: Prisma.TransactionClient,
  partnerId: string
): Promise<boolean> {
  const { count } = await tx.wallet.createMany({ data: [{ partnerId }], skipDuplicates: true });
  return count === 1;
}

/**
 * Opens an empty wallet for every verified partner who has none, with one audit entry
 * per wallet (empty actor = system). Used by the seed. Returns how many were opened and
 * how many verified partners already had one.
 */
export async function openMissingWallets(
  tx: Prisma.TransactionClient,
  source: string
): Promise<{ opened: number; existing: number }> {
  const verified: Prisma.UserWhereInput = {
    roleId: ROLE.PARTNER,
    partnerProfile: { is: { kycState: "verified" } },
  };
  const [missing, existing] = await Promise.all([
    tx.user.findMany({
      where: { ...verified, wallet: { is: null } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    }),
    tx.user.count({ where: { ...verified, wallet: { isNot: null } } }),
  ]);

  let opened = 0;
  for (const partner of missing) {
    if (!(await openWallet(tx, partner.id))) continue;
    await recordAudit(tx, {
      actorId: null,
      action: "wallet.open",
      entity: { type: "partner", id: partner.id },
      after: { available: 0, held: 0, source },
    });
    opened++;
  }
  return { opened, existing };
}

// ---------------------------------------------------------------------------
// The wallet (balance card)
// ---------------------------------------------------------------------------

/** Short English label per line type (DEC-133). The app may translate by `type`. */
const LABELS: Record<LedgerEntryType, string | Record<LedgerDirection, string>> = {
  earn: "Scan reward",
  hold: "Cash-out requested",
  release: "Cash-out cancelled, points returned",
  redeem: "Cash-out paid",
  refund: "Cash-out failed, points returned",
  adjust: { credit: "Points added by JP Interio", debit: "Points removed by JP Interio" },
};

/** Shown instead of a staff member's name to partners, ASMs and SEs (DEC-133, DEC-134). */
const COMPANY_NAME = "JP Interio";

export function ledgerLabel(type: LedgerEntryType, direction: LedgerDirection): string {
  const label = LABELS[type];
  return typeof label === "string" ? label : label[direction];
}

/** How each type moves available and held (signed), for the app's +/− display. */
function changes(type: LedgerEntryType, direction: LedgerDirection, points: number) {
  switch (type) {
    case "earn":
    case "refund":
      return { availableChange: points, heldChange: 0 };
    case "hold":
      return { availableChange: -points, heldChange: points };
    case "release":
      return { availableChange: points, heldChange: -points };
    case "redeem":
      return { availableChange: 0, heldChange: -points };
    case "adjust":
      return { availableChange: direction === "credit" ? points : -points, heldChange: 0 };
  }
}

/** The wallet totals as the apps see them, with rupees worked out by the server. */
function toWalletView(
  wallet: {
    available: number;
    held: number;
    lifetimeEarned: number;
    lifetimeRedeemed: number;
    netAdjusted: number;
    scanCount: number;
    updatedAt: Date;
  },
  frozen: boolean
) {
  return {
    available: wallet.available,
    availableRupees: pointsToRupees(wallet.available),
    held: wallet.held,
    heldRupees: pointsToRupees(wallet.held),
    lifetimeEarned: wallet.lifetimeEarned,
    lifetimeRedeemed: wallet.lifetimeRedeemed,
    lifetimeRedeemedRupees: pointsToRupees(wallet.lifetimeRedeemed),
    netAdjusted: wallet.netAdjusted,
    scanCount: wallet.scanCount,
    /** True when the partner is not active and verified: no points can move (DEC-131). */
    frozen,
    updatedAt: wallet.updatedAt,
  };
}

/** The wallet view, or null when the partner has no wallet. */
async function loadWallet(partnerId: string) {
  const partner = await prisma.user.findUnique({
    where: { id: partnerId },
    select: { status: true, partnerProfile: { select: { kycState: true } }, wallet: true },
  });
  if (!partner?.wallet) return null;
  return toWalletView(
    partner.wallet,
    isWalletFrozen(partner.status, partner.partnerProfile?.kycState)
  );
}

/**
 * GET /api/partner/wallet — the partner's own wallet. A verified partner always has one;
 * a missing one is a bug (logged).
 */
export async function getWallet(partnerId: string) {
  const wallet = await loadWallet(partnerId);
  if (!wallet) {
    logger.error({ partnerId }, "Partner has no wallet");
    throw new AppError("Your wallet could not be found. Please contact support.");
  }
  return wallet;
}

const NO_WALLET_NOTE = "No wallet yet: the partner isn't verified.";

/** A staff answer about one partner's wallet: the wallet, or null with a note (DEC-134). */
async function walletForStaff(partnerId: string) {
  const wallet = await loadWallet(partnerId);
  return { wallet, note: wallet ? null : NO_WALLET_NOTE };
}

/** A partner this staff member may see (scope; outside → 404). Retired drafts → 404. */
export async function assertPartnerInScope(
  me: AuthUser,
  scope: PermissionScope,
  partnerId: string
) {
  assertInScope(
    await prisma.user.findFirst({
      where: {
        AND: [
          { id: partnerId },
          scopeForPartners(me, scope),
          { partnerProfile: { is: { draftRemovedAt: null } } },
        ],
      },
      select: { id: true },
    }),
    { user: me, entity: "partner", id: partnerId }
  );
}

/** GET /api/partners/:id/wallet — `ledger.view` within scope (DEC-134). */
export async function getPartnerWallet(me: AuthUser, scope: PermissionScope, partnerId: string) {
  await assertPartnerInScope(me, scope, partnerId);
  return { partnerId, ...(await walletForStaff(partnerId)) };
}

/**
 * The points box in Partner 360 (DEC-134): only for staff who have `ledger.view`, with the
 * partner inside that scope. Returns undefined to leave the box out.
 */
export async function pointsBoxFor360(me: AuthUser, partnerId: string) {
  const scope = await getPermissionScope(me, "ledger.view");
  if (!scope) return undefined;
  const inScope = await prisma.user.count({
    where: { AND: [{ id: partnerId }, scopeForPartners(me, scope)] },
  });
  if (inScope === 0) return undefined;
  return walletForStaff(partnerId);
}

// ---------------------------------------------------------------------------
// Ledger lines (passbook)
// ---------------------------------------------------------------------------

/**
 * Who may see staff names on lines (DEC-133, DEC-134): Admin, Sub-Admin and Zonal Head.
 * Partners, ASMs and Sales Executives see "JP Interio".
 */
function seesStaffNames(viewer: Pick<AuthUser, "roleId"> | "partner"): boolean {
  if (viewer === "partner") return false;
  const roles: number[] = [ROLE.ADMIN, ROLE.SUB_ADMIN, ROLE.ZONAL_HEAD];
  return roles.includes(viewer.roleId);
}

const PARTNER_SELECT = {
  id: true,
  name: true,
  phone: true,
  zone: { select: { id: true, name: true, code: true } },
  partnerProfile: { select: { businessName: true } },
} as const;

type LineRow = RewardsLedgerEntry & {
  createdBy: { id: string; name: string | null } | null;
  partner?: {
    id: string;
    name: string | null;
    phone: string;
    zone: { id: string; name: string; code: string } | null;
    partnerProfile: { businessName: string | null } | null;
  };
};

/**
 * One statement line.
 * - "by" is the real staff name only for viewers allowed to see it; otherwise "JP Interio".
 * - Scan lines carry the product name and QR code (DEC-133); payout lines the request id.
 * - The across-partners ledger also shows the partner (DEC-134).
 */
function toLine(
  row: LineRow,
  showStaffNames: boolean,
  scans: Map<string, { code: string; productName: string }>
) {
  const by = row.createdBy
    ? showStaffNames
      ? { id: row.createdBy.id, name: row.createdBy.name }
      : { name: COMPANY_NAME }
    : null;
  return {
    id: row.id,
    ...(row.partner && {
      partner: {
        id: row.partner.id,
        name: row.partner.name,
        phone: row.partner.phone,
        businessName: row.partner.partnerProfile?.businessName ?? null,
        zone: row.partner.zone,
      },
    }),
    type: row.type,
    label: ledgerLabel(row.type, row.direction),
    direction: row.direction,
    points: row.points,
    ...changes(row.type, row.direction, row.points),
    availableAfter: row.availableAfter,
    heldAfter: row.heldAfter,
    reason: row.reason,
    /** Who made it; empty when the system did (scan, automatic refund). */
    by,
    scan: row.sourceType === "scan" && row.sourceId ? (scans.get(row.sourceId) ?? null) : null,
    payoutId: row.sourceType === "payout" ? row.sourceId : null,
    createdAt: row.createdAt,
  };
}

/** Ledger filter from the statement query (type, direction, date range). */
function statementWhere(query: StatementQuery): Prisma.RewardsLedgerEntryWhereInput {
  return {
    ...(query.type && { type: { in: query.type } }),
    ...(query.direction && { direction: query.direction }),
    ...((query.from || query.to) && {
      createdAt: {
        ...(query.from && { gte: query.from }),
        ...(query.to && { lte: query.to }),
      },
    }),
  };
}

/**
 * Ledger lines, paged, newest first by default. `where` must already limit the lines
 * to what the viewer may see (one partner, or the viewer's scope).
 */
async function listLedgerLines(
  where: Prisma.RewardsLedgerEntryWhereInput,
  query: StatementQuery,
  options: { showStaffNames: boolean; withPartner: boolean }
) {
  const [rows, total] = await Promise.all([
    prisma.rewardsLedgerEntry.findMany({
      where,
      include: {
        createdBy: { select: { id: true, name: true } },
        partner: { select: PARTNER_SELECT },
      },
      orderBy: toPrismaOrderBy(query.sort),
      ...toPrismaPaging(query.page, query.limit),
    }),
    prisma.rewardsLedgerEntry.count({ where }),
  ]);

  // Scan lines: product name + QR code, in one query (DEC-133).
  const scanIds = rows.flatMap((row) =>
    row.sourceType === "scan" && row.sourceId ? [row.sourceId] : []
  );
  const scans = new Map<string, { code: string; productName: string }>();
  if (scanIds.length > 0) {
    const codes = await prisma.qrCode.findMany({
      where: { id: { in: scanIds } },
      select: { id: true, code: true, product: { select: { name: true } } },
    });
    for (const code of codes) {
      scans.set(code.id, { code: code.code, productName: code.product.name });
    }
  }

  return {
    items: rows.map((row) =>
      toLine(
        options.withPartner ? row : { ...row, partner: undefined },
        options.showStaffNames,
        scans
      )
    ),
    meta: pageMeta(query.page, query.limit, total),
  };
}

/** GET /api/partner/wallet/statement — the partner's own passbook. */
export async function getMyStatement(partnerId: string, query: StatementQuery) {
  return listLedgerLines({ partnerId, ...statementWhere(query) }, query, {
    showStaffNames: seesStaffNames("partner"),
    withPartner: false,
  });
}

/** One ledger line, shown as staff see it (e.g. the reply after an adjustment, T6). */
export async function getLineForStaff(me: AuthUser, entryId: string) {
  const { items } = await listLedgerLines(
    { id: entryId },
    { page: 1, limit: 1, sort: "-createdAt" },
    { showStaffNames: seesStaffNames(me), withPartner: false }
  );
  return items[0] ?? null;
}

/** GET /api/partners/:id/ledger — one partner's passbook, `ledger.view` within scope. */
export async function getPartnerLedger(
  me: AuthUser,
  scope: PermissionScope,
  partnerId: string,
  query: StatementQuery
) {
  await assertPartnerInScope(me, scope, partnerId);
  return listLedgerLines({ partnerId, ...statementWhere(query) }, query, {
    showStaffNames: seesStaffNames(me),
    withPartner: false,
  });
}

/**
 * GET /api/ledger — lines across every partner in the viewer's scope (DEC-134), with
 * totals for the whole filter (not just the page): line count, points in / out, per type.
 */
export async function listLedger(me: AuthUser, scope: PermissionScope, query: LedgerQuery) {
  const partnerWhere: Prisma.UserWhereInput = {
    AND: [
      scopeForPartners(me, scope),
      {
        ...(query.zoneId && { zoneId: query.zoneId }),
        ...(query.asmId && { parentId: query.asmId }),
        ...(query.partnerId && { id: query.partnerId }),
      },
      ...(query.search
        ? [
            {
              OR: [
                { name: { contains: query.search, mode: "insensitive" as const } },
                { phone: { contains: query.search } },
                {
                  partnerProfile: {
                    is: { businessName: { contains: query.search, mode: "insensitive" as const } },
                  },
                },
              ],
            },
          ]
        : []),
    ],
  };
  const where: Prisma.RewardsLedgerEntryWhereInput = {
    partner: { is: partnerWhere },
    ...statementWhere(query),
    ...(query.createdById && { createdById: query.createdById }),
  };

  const [page, groups] = await Promise.all([
    listLedgerLines(where, query, { showStaffNames: seesStaffNames(me), withPartner: true }),
    prisma.rewardsLedgerEntry.groupBy({
      by: ["type", "direction"],
      where,
      _count: { _all: true },
      _sum: { points: true },
    }),
  ]);

  const totals = {
    lines: 0,
    pointsIn: 0,
    pointsOut: 0,
    byType: {} as Partial<Record<LedgerEntryType, { lines: number; points: number }>>,
  };
  for (const group of groups) {
    const lines = group._count._all;
    const points = group._sum.points ?? 0;
    totals.lines += lines;
    if (group.direction === "credit") totals.pointsIn += points;
    else totals.pointsOut += points;
    const byType = (totals.byType[group.type] ??= { lines: 0, points: 0 });
    byType.lines += lines;
    // Adjustments mix credits and debits: their "points" is the net (credits − debits).
    byType.points += group.type === "adjust" && group.direction === "debit" ? -points : points;
  }

  return { ...page, totals };
}

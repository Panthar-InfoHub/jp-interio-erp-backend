import type { Prisma } from "../generated/prisma/client.js";
import type { PermissionScope } from "../generated/prisma/enums.js";
import { ROLE } from "../config/roles.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { pageMeta, toPrismaOrderBy, toPrismaPaging } from "../utils/pagination.js";
import type { ScanHistoryQuery } from "../validators/scan.schema.js";
import { assertPartnerInScope } from "./wallet.service.js";

/**
 * Scan history (Module 9 T4, DEC-145). Read-only.
 * - Partner: their own scans only (no partner id in the address).
 * - Staff: one partner's scans, `scans.view` within scope (out of scope → 404). Scope
 *   follows the partner's current owner, so the owner sees the whole history (DEC-134).
 * - Device id and IP only for the Admin and Sub-Admins (DEC-145).
 * - Totals (scans, points) are for the whole filter, not just the page.
 * Failed attempts are not listed anywhere yet (DEC-144).
 */

type ListOptions = {
  /** Staff lines also show the batch number. */
  withBatch: boolean;
  /** Admin and Sub-Admins only. */
  withDevice: boolean;
};

/** The Admin and Sub-Admins see a scan's device id and IP (DEC-145). */
function seesDeviceDetails(me: AuthUser): boolean {
  return me.roleId === ROLE.ADMIN || me.roleId === ROLE.SUB_ADMIN;
}

function historyWhere(partnerId: string, query: ScanHistoryQuery): Prisma.ScanWhereInput {
  return {
    partnerId,
    ...(query.productId && { productId: query.productId }),
    ...((query.from || query.to) && {
      scannedAt: { ...(query.from && { gte: query.from }), ...(query.to && { lte: query.to }) },
    }),
  };
}

async function listScans(
  where: Prisma.ScanWhereInput,
  query: ScanHistoryQuery,
  options: ListOptions,
  db: Prisma.TransactionClient
) {
  const [rows, totals] = await Promise.all([
    db.scan.findMany({
      where,
      orderBy: toPrismaOrderBy(query.sort),
      ...toPrismaPaging(query.page, query.limit),
      select: {
        id: true,
        points: true,
        scannedAt: true,
        deviceId: true,
        ip: true,
        qrCode: { select: { code: true } },
        product: { select: { id: true, sku: true, name: true, imageUrl: true } },
        batch: { select: { id: true, batchNo: true } },
      },
    }),
    db.scan.aggregate({ where, _count: { _all: true }, _sum: { points: true } }),
  ]);

  const items = rows.map((row) => ({
    id: row.id,
    scannedAt: row.scannedAt,
    code: row.qrCode.code,
    points: row.points,
    product: row.product,
    ...(options.withBatch && { batch: row.batch }),
    ...(options.withDevice && { deviceId: row.deviceId, ip: row.ip }),
  }));

  const total = totals._count._all;
  return {
    items,
    meta: {
      ...pageMeta(query.page, query.limit, total),
      totals: { scans: total, points: totals._sum.points ?? 0 },
    },
  };
}

/**
 * GET /api/partner/scans — the partner's own scans.
 * `db` is for checks that run inside a rolled-back transaction.
 */
export async function getMyScans(
  partnerId: string,
  query: ScanHistoryQuery,
  db: Prisma.TransactionClient = prisma
) {
  return listScans(
    historyWhere(partnerId, query),
    query,
    { withBatch: false, withDevice: false },
    db
  );
}

/** GET /api/partners/:id/scans — one partner's scans, `scans.view` within scope. */
export async function getPartnerScans(
  me: AuthUser,
  scope: PermissionScope,
  partnerId: string,
  query: ScanHistoryQuery,
  db: Prisma.TransactionClient = prisma
) {
  await assertPartnerInScope(me, scope, partnerId);
  return listScans(
    historyWhere(partnerId, query),
    query,
    { withBatch: true, withDevice: seesDeviceDetails(me) },
    db
  );
}

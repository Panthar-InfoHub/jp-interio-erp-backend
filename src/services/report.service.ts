import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { pointsToRupees } from "../utils/money.js";

/**
 * Points liability report (Module 8 T7; DEC-045, DEC-136). Admin only.
 * - Owed = available + held, for every partner, as of a moment (default: now). For each
 *   partner it uses the balances of their LAST ledger line at or before that moment, so
 *   the total is exact for any past date.
 * - Frozen wallets are included and also shown separately ("of which frozen").
 * - Zones and "frozen" are as they are TODAY: no zone or status history is kept.
 */

type ZoneRow = {
  zone_id: string | null;
  partners_with_points: number;
  available: bigint;
  held: bigint;
  frozen: bigint;
};

const NOTE =
  "Totals are exact for the chosen moment. Zones and frozen status are as they are today.";

function amounts(available: number, held: number, frozen: number) {
  const owed = available + held;
  return {
    available,
    held,
    owed,
    owedRupees: pointsToRupees(owed),
    frozen,
    frozenRupees: pointsToRupees(frozen),
  };
}

/** `db`: the shared client, or a caller's transaction (e.g. a check that rolls back). */
export async function getPointsLiability(
  asOf: Date = new Date(),
  db: Prisma.TransactionClient = prisma
) {
  // Frozen = not active or not verified: the same rule as isWalletFrozen (DEC-129).
  const rows = await db.$queryRaw<ZoneRow[]>`
    WITH last_line AS (
      SELECT DISTINCT ON (l.partner_id) l.partner_id, l.available_after, l.held_after
      FROM rewards_ledger l
      WHERE l.created_at <= ${asOf}
      ORDER BY l.partner_id, l.created_at DESC, l.id DESC
    )
    SELECT
      u.zone_id::text AS zone_id,
      (COUNT(*) FILTER (WHERE ll.available_after + ll.held_after > 0))::int AS partners_with_points,
      COALESCE(SUM(ll.available_after), 0)::bigint AS available,
      COALESCE(SUM(ll.held_after), 0)::bigint AS held,
      COALESCE(SUM(ll.available_after + ll.held_after) FILTER (
        WHERE u.status <> 'active' OR p.kyc_state IS DISTINCT FROM 'verified'
      ), 0)::bigint AS frozen
    FROM last_line ll
    JOIN users u ON u.id = ll.partner_id
    LEFT JOIN partner_profiles p ON p.user_id = u.id
    GROUP BY u.zone_id`;

  const zones = await db.zone.findMany({
    select: { id: true, name: true, code: true, status: true },
    orderBy: { name: "asc" },
  });
  const byZone = new Map(rows.map((row) => [row.zone_id, row]));

  const toZone = (row: ZoneRow | undefined) => ({
    partnersWithPoints: row?.partners_with_points ?? 0,
    ...amounts(Number(row?.available ?? 0), Number(row?.held ?? 0), Number(row?.frozen ?? 0)),
  });

  // Every active zone (even with nothing owed), plus any inactive zone that still owes.
  const zoneLines = zones
    .filter((zone) => zone.status === "active" || byZone.has(zone.id))
    .map((zone) => ({
      /** Empty for the "No zone" row (partners without a zone). */
      zone: { id: zone.id, name: zone.name, code: zone.code, status: zone.status } as {
        id: string;
        name: string;
        code: string;
        status: string;
      } | null,
      ...toZone(byZone.get(zone.id)),
    }));
  const noZone = byZone.get(null);
  if (noZone) zoneLines.push({ zone: null, ...toZone(noZone) });

  const total = rows.reduce(
    (sum, row) => ({
      partnersWithPoints: sum.partnersWithPoints + row.partners_with_points,
      available: sum.available + Number(row.available),
      held: sum.held + Number(row.held),
      frozen: sum.frozen + Number(row.frozen),
    }),
    { partnersWithPoints: 0, available: 0, held: 0, frozen: 0 }
  );

  return {
    asOf,
    note: NOTE,
    total: {
      partnersWithPoints: total.partnersWithPoints,
      ...amounts(total.available, total.held, total.frozen),
    },
    zones: zoneLines,
  };
}

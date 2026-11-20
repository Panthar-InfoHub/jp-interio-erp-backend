import type { Prisma } from "../generated/prisma/client.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { type AuditEntry, recordAudit } from "./audit.service.js";

/**
 * Ledger reconciliation (Module 8 T8, DEC-137). READ-ONLY on points: it never fixes
 * anything, it only flags (D8.41). Run by hand: `npm run job:reconcile-ledger` (D8.39).
 *
 * For every wallet it checks:
 *   1. totals = the sum of the partner's ledger lines (available, held, lifetime earned,
 *      lifetime redeemed, net adjusted, scan count);
 *   2. the newest line's balances = the wallet's balances;
 *   3. every line's balances follow from the line before it (no broken chain);
 * and that no ledger lines exist for a partner without a wallet.
 *
 * Mismatches → an error in the server log + one `ledger.reconcile_mismatch` audit entry
 * (D8.40). A clean run only logs a short summary.
 *
 * Line order is (created_at, id). Lines saved in one transaction share created_at, so if
 * one transaction ever posts several moves for the same partner, their order falls back
 * to the id; today every feature posts one move per partner per transaction.
 */

export type Mismatch = {
  partnerId: string;
  check: "totals" | "last_line" | "chain" | "no_wallet";
  field?: string;
  expected?: number | string;
  found?: number | string;
  ledgerEntryId?: string;
};

/** How each line moves available and held (same rules as the ledger service, DEC-129). */
const AVAILABLE_CHANGE = `CASE
  WHEN l.type IN ('earn', 'refund', 'release') THEN l.points
  WHEN l.type = 'hold' THEN -l.points
  WHEN l.type = 'adjust' THEN CASE WHEN l.direction = 'credit' THEN l.points ELSE -l.points END
  ELSE 0 END`;
const HELD_CHANGE = `CASE
  WHEN l.type = 'hold' THEN l.points
  WHEN l.type IN ('release', 'redeem') THEN -l.points
  ELSE 0 END`;

type TotalsRow = {
  partner_id: string;
  available: number;
  held: number;
  lifetime_earned: number;
  lifetime_redeemed: number;
  net_adjusted: number;
  scan_count: number;
  sum_available: number;
  sum_held: number;
  sum_earned: number;
  sum_redeemed: number;
  sum_adjusted: number;
  sum_scans: number;
  last_available: number | null;
  last_held: number | null;
  lines: number;
};

type ChainRow = {
  id: string;
  partner_id: string;
  available_after: number;
  held_after: number;
  expected_available: number;
  expected_held: number;
};

/** `db`: the shared client, or a caller's transaction (e.g. a check that rolls back). */
export async function reconcileLedger(db: Prisma.TransactionClient = prisma) {
  // 1 + 2: every wallet against the sum of its lines and its newest line.
  const totals = await db.$queryRawUnsafe<TotalsRow[]>(`
    WITH sums AS (
      SELECT l.partner_id,
        SUM(${AVAILABLE_CHANGE})::int AS sum_available,
        SUM(${HELD_CHANGE})::int AS sum_held,
        SUM(CASE WHEN l.type = 'earn' THEN l.points ELSE 0 END)::int AS sum_earned,
        SUM(CASE WHEN l.type = 'redeem' THEN l.points
                 WHEN l.type = 'refund' THEN -l.points ELSE 0 END)::int AS sum_redeemed,
        SUM(CASE WHEN l.type = 'adjust' AND l.direction = 'credit' THEN l.points
                 WHEN l.type = 'adjust' THEN -l.points ELSE 0 END)::int AS sum_adjusted,
        COUNT(*) FILTER (WHERE l.type = 'earn')::int AS sum_scans,
        COUNT(*)::int AS lines
      FROM rewards_ledger l
      GROUP BY l.partner_id
    ),
    last_line AS (
      SELECT DISTINCT ON (l.partner_id) l.partner_id, l.available_after, l.held_after
      FROM rewards_ledger l
      ORDER BY l.partner_id, l.created_at DESC, l.id DESC
    )
    SELECT w.partner_id::text AS partner_id, w.available, w.held, w.lifetime_earned,
      w.lifetime_redeemed, w.net_adjusted, w.scan_count,
      COALESCE(s.sum_available, 0) AS sum_available, COALESCE(s.sum_held, 0) AS sum_held,
      COALESCE(s.sum_earned, 0) AS sum_earned, COALESCE(s.sum_redeemed, 0) AS sum_redeemed,
      COALESCE(s.sum_adjusted, 0) AS sum_adjusted, COALESCE(s.sum_scans, 0) AS sum_scans,
      ll.available_after AS last_available, ll.held_after AS last_held,
      COALESCE(s.lines, 0) AS lines
    FROM wallets w
    LEFT JOIN sums s ON s.partner_id = w.partner_id
    LEFT JOIN last_line ll ON ll.partner_id = w.partner_id`);

  // 3: each line's balances = the previous line's balances + this line's change.
  const brokenChain = await db.$queryRawUnsafe<ChainRow[]>(`
    WITH ordered AS (
      SELECT l.id, l.partner_id, l.available_after, l.held_after,
        COALESCE(LAG(l.available_after) OVER w, 0) + ${AVAILABLE_CHANGE} AS expected_available,
        COALESCE(LAG(l.held_after) OVER w, 0) + ${HELD_CHANGE} AS expected_held
      FROM rewards_ledger l
      WINDOW w AS (PARTITION BY l.partner_id ORDER BY l.created_at, l.id)
    )
    SELECT id::text AS id, partner_id::text AS partner_id, available_after, held_after,
      expected_available::int AS expected_available, expected_held::int AS expected_held
    FROM ordered
    WHERE available_after <> expected_available OR held_after <> expected_held`);

  // 4: ledger lines for a partner who has no wallet.
  const noWallet = await db.$queryRawUnsafe<{ partner_id: string; lines: number }[]>(`
    SELECT l.partner_id::text AS partner_id, COUNT(*)::int AS lines
    FROM rewards_ledger l
    LEFT JOIN wallets w ON w.partner_id = l.partner_id
    WHERE w.partner_id IS NULL
    GROUP BY l.partner_id`);

  const mismatches: Mismatch[] = [];
  const fields: [keyof TotalsRow, keyof TotalsRow, string][] = [
    ["available", "sum_available", "available"],
    ["held", "sum_held", "held"],
    ["lifetime_earned", "sum_earned", "lifetimeEarned"],
    ["lifetime_redeemed", "sum_redeemed", "lifetimeRedeemed"],
    ["net_adjusted", "sum_adjusted", "netAdjusted"],
    ["scan_count", "sum_scans", "scanCount"],
  ];
  let linesChecked = 0;
  for (const row of totals) {
    linesChecked += row.lines;
    for (const [walletField, sumField, name] of fields) {
      if (row[walletField] !== row[sumField]) {
        mismatches.push({
          partnerId: row.partner_id,
          check: "totals",
          field: name,
          expected: row[sumField] as number,
          found: row[walletField] as number,
        });
      }
    }
    // A wallet with no lines must be all zeros (covered above); with lines, the newest
    // line's balances must be the wallet's.
    if (row.lines > 0) {
      if (row.last_available !== row.available) {
        mismatches.push({
          partnerId: row.partner_id,
          check: "last_line",
          field: "available",
          expected: row.last_available ?? 0,
          found: row.available,
        });
      }
      if (row.last_held !== row.held) {
        mismatches.push({
          partnerId: row.partner_id,
          check: "last_line",
          field: "held",
          expected: row.last_held ?? 0,
          found: row.held,
        });
      }
    }
  }
  for (const line of brokenChain) {
    mismatches.push({
      partnerId: line.partner_id,
      check: "chain",
      field: "available/held",
      expected: `${line.expected_available}/${line.expected_held}`,
      found: `${line.available_after}/${line.held_after}`,
      ledgerEntryId: line.id,
    });
  }
  for (const row of noWallet) {
    linesChecked += row.lines;
    mismatches.push({ partnerId: row.partner_id, check: "no_wallet", found: row.lines });
  }

  const summary = {
    walletsChecked: totals.length,
    linesChecked,
    mismatchCount: mismatches.length,
    partnersAffected: new Set(mismatches.map((m) => m.partnerId)).size,
  };

  if (mismatches.length === 0) {
    logger.info(summary, "Ledger reconciliation: no mismatches");
  } else {
    logger.error(
      { ...summary, mismatches: mismatches.slice(0, 50) },
      "Ledger reconciliation found mismatches"
    );
    // A permanent record for the Admin (D8.40). The list is capped to keep the entry small.
    const entry: AuditEntry = {
      actorId: null,
      action: "ledger.reconcile_mismatch",
      entity: { type: "ledger" },
      after: { ...summary, mismatches: mismatches.slice(0, 200) },
    };
    if (db === prisma) {
      await prisma.$transaction((tx) => recordAudit(tx, entry));
    } else {
      await recordAudit(db, entry);
    }
  }

  return { ...summary, mismatches };
}

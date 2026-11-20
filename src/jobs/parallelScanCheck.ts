import { ROLES } from "../config/roles.js";
import { isProd } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { createBatch } from "../services/qrBatch.service.js";
import { scanCode } from "../services/scan.service.js";
import { qrLink } from "../utils/qrCode.js";

/**
 * `npm run check:parallel-scan` — DEV ONLY (Module 9 T5, DEC-146).
 *
 * Proves "a code can be scanned successfully exactly once": makes a 1-code TEST batch
 * (10 points) as the QR Sub-Admin, then fires 20 scans of that code at the same moment,
 * 10 by test partner A and 10 by test partner C, through the real scan service.
 *
 * Expected: exactly 1 new scan; the winner's other 9 → "already counted" (no new points);
 * the other partner's 10 → ALREADY_SCANNED. Then it checks the database.
 *
 * It LEAVES PERMANENT ROWS (a batch, a scan, an `earn` ledger line, 10 failed attempts,
 * audit entries): ledger lines can never be deleted. Needs the dev test company
 * (`npm run db:dev-data`) and the TEST product with SKU `TEST-SCAN-CHECK`.
 * Refuses to run when NODE_ENV=production.
 */

const PARALLEL = 20;
const POINTS = 10;
const QR_SUB_ADMIN = "919000000106";
const PARTNER_A = "919000000141";
const PARTNER_C = "919000000143";
const PRODUCT_SKU_KEY = "TESTSCANCHECK";

/** The same user object `requireAuth` builds, read from the database. */
async function authUserByPhone(phone: string): Promise<AuthUser> {
  const user = await prisma.user.findUnique({
    where: { phone },
    select: {
      id: true,
      name: true,
      phone: true,
      roleId: true,
      zoneId: true,
      parentId: true,
      subAdminAreas: { select: { area: true } },
    },
  });
  const role = user && ROLES.find((r) => r.id === user.roleId);
  if (!user || !role) throw new Error(`Test user ${phone} not found. Run npm run db:dev-data.`);
  return {
    id: user.id,
    sessionId: "parallel-scan-check",
    app: role.app,
    name: user.name,
    phone: user.phone,
    roleId: role.id,
    roleKey: role.key,
    tier: role.tier,
    zoneId: user.zoneId,
    parentId: user.parentId,
    subAdminAreas: user.subAdminAreas.map((grant) => grant.area),
  };
}

let failed = 0;
function check(label: string, ok: boolean, extra = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
}

async function main() {
  if (isProd) throw new Error("This check is for the dev database only.");

  const product = await prisma.product.findUnique({
    where: { skuKey: PRODUCT_SKU_KEY },
    select: { id: true, active: true },
  });
  if (!product?.active) {
    throw new Error("The active TEST product with SKU TEST-SCAN-CHECK is missing.");
  }

  const [qr, partnerA, partnerC] = await Promise.all(
    [QR_SUB_ADMIN, PARTNER_A, PARTNER_C].map(authUserByPhone)
  );
  const partners = [partnerA!, partnerC!];

  const batch = await createBatch(qr!, {
    productId: product.id,
    quantity: 1,
    pointsPerCode: POINTS,
    notes: "TEST parallel-scan check (npm run check:parallel-scan)",
  });
  const { id: qrCodeId, code } = await prisma.qrCode.findFirstOrThrow({
    where: { batchId: batch.id },
    select: { id: true, code: true },
  });
  console.log(`Batch ${batch.batchNo}, code ${code}: firing ${PARALLEL} scans at once…`);

  const before = new Map(
    await Promise.all(
      partners.map(
        async (p) =>
          [p.id, await prisma.wallet.findUniqueOrThrow({ where: { partnerId: p.id } })] as const
      )
    )
  );

  const started = Date.now();
  const outcomes = await Promise.all(
    Array.from({ length: PARALLEL }, async (_, i) => {
      const partner = partners[i % 2]!;
      try {
        const result = await scanCode(partner, { code: qrLink(code), deviceId: `parallel-${i}` });
        return { partner, outcome: result.alreadyCounted ? "retry" : "new" };
      } catch (error) {
        const errorCode = (error as { code?: string }).code ?? "crash";
        return { partner, outcome: errorCode };
      }
    })
  );
  console.log(`All ${PARALLEL} answered in ${Date.now() - started} ms.`);

  const winners = outcomes.filter((o) => o.outcome === "new");
  check("exactly 1 scan won", winners.length === 1, `(${winners.length})`);
  const winner = winners[0]?.partner ?? partnerA!;
  const loser = winner === partnerA ? partnerC! : partnerA!;
  const count = (p: AuthUser, outcome: string) =>
    outcomes.filter((o) => o.partner === p && o.outcome === outcome).length;
  check("the winner's other scans → already counted", count(winner, "retry") === PARALLEL / 2 - 1);
  check(
    "the other partner's scans → ALREADY_SCANNED",
    count(loser, "ALREADY_SCANNED") === PARALLEL / 2
  );
  check(
    "no crashes or other errors",
    outcomes.every((o) => ["new", "retry", "ALREADY_SCANNED"].includes(o.outcome))
  );

  const [scans, lines, attempts, winnerWallet, loserWallet] = await Promise.all([
    prisma.scan.count({ where: { qrCodeId } }),
    prisma.rewardsLedgerEntry.count({ where: { sourceType: "scan", sourceId: qrCodeId } }),
    prisma.scanAttempt.count({
      where: { qrCodeId, partnerId: loser.id, reason: "already_scanned" },
    }),
    prisma.wallet.findUniqueOrThrow({ where: { partnerId: winner.id } }),
    prisma.wallet.findUniqueOrThrow({ where: { partnerId: loser.id } }),
  ]);
  const winnerBefore = before.get(winner.id)!;
  const loserBefore = before.get(loser.id)!;
  check("1 row in scans", scans === 1, `(${scans})`);
  check("1 earn line in the ledger", lines === 1, `(${lines})`);
  check(
    `winner (${winner.phone}) +${POINTS} once`,
    winnerWallet.available === winnerBefore.available + POINTS &&
      winnerWallet.scanCount === winnerBefore.scanCount + 1,
    `(${winnerBefore.available} → ${winnerWallet.available})`
  );
  check(
    `other partner (${loser.phone}) unchanged`,
    loserWallet.available === loserBefore.available &&
      loserWallet.scanCount === loserBefore.scanCount
  );
  check(`${PARALLEL / 2} failed attempts saved for the other partner`, attempts === PARALLEL / 2);

  console.log(failed === 0 ? "ALL PASS" : `${failed} CHECK(S) FAILED`);
  if (failed > 0) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(
    "Parallel-scan check stopped:",
    error instanceof Error ? error.message : "could not connect to the database. Try again."
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

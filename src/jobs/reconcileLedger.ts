import { prisma } from "../lib/prisma.js";
import { reconcileLedger } from "../services/reconcile.service.js";

/**
 * `npm run job:reconcile-ledger`: checks every wallet against its ledger lines, once, by
 * hand (Module 8 T8, DEC-137). Read-only on points; never fixes anything. Mismatches are
 * logged as errors and saved as a `ledger.reconcile_mismatch` audit entry.
 * Exit code 1 when anything is wrong, so a scheduler can raise an alert later.
 */
try {
  const result = await reconcileLedger();
  console.log(
    `Ledger reconciliation: ${result.walletsChecked} wallet(s), ${result.linesChecked} line(s) checked, ` +
      `${result.mismatchCount} mismatch(es).`
  );
  if (result.mismatchCount > 0) {
    console.table(result.mismatches.slice(0, 50));
    console.log("Saved as an audit entry: ledger.reconcile_mismatch. Nothing was changed.");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    "Ledger reconciliation failed:",
    error instanceof Error
      ? error.message
      : "could not connect to the database (it may be waking up). Try again in a few seconds."
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

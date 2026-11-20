import { prisma } from "../lib/prisma.js";
import { escalateOverdueTasks } from "../services/taskEscalation.service.js";

/**
 * `npm run job:escalate-tasks`: runs the overdue-task check once (DEC-176, DEC-183), by hand
 * or from a hosting platform's scheduler (00:30 IST = 19:00 UTC). Safe to run any time:
 * each overdue task is flagged to its doer's manager only once.
 */
try {
  const r = await escalateOverdueTasks();
  console.log(
    `Overdue task check (India date ${r.today}): ${r.found} found, ${r.flagged} flagged, ` +
      `${r.skipped} skipped, ${r.noManager} with no active manager.`
  );
} catch (error) {
  console.error("Overdue task check failed:", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

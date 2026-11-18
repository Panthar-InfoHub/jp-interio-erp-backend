import { prisma } from "../lib/prisma.js";
import { removeExpiredDrafts } from "../services/draftCleanup.service.js";

/**
 * `npm run job:clean-drafts`: runs the draft clean-up once, by hand (DEC-093).
 * Retires every unfinished onboarding older than `onboarding.draft_days`.
 */
try {
  const result = await removeExpiredDrafts();
  console.log(
    `Draft clean-up: ${result.retired} draft(s) retired (older than ${result.days} days), ${result.filesDeleted} file(s) deleted.`
  );
} catch (error) {
  console.error("Draft clean-up failed:", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

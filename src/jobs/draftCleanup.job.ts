import { logger } from "../lib/logger.js";
import { removeExpiredDrafts } from "../services/draftCleanup.service.js";

/**
 * Runs the draft clean-up (DEC-093) inside the server: a few minutes after start-up,
 * then once a day. Running it more than once (e.g. two server copies) is harmless.
 * For a scheduled job on the production server instead, use `npm run job:clean-drafts`.
 */

const FIRST_RUN_MS = 5 * 60 * 1000;
const EVERY_MS = 24 * 60 * 60 * 1000;

let running = false;

export async function runDraftCleanup(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await removeExpiredDrafts();
    logger.info(result, "Draft clean-up finished");
  } catch (error) {
    logger.error({ err: error }, "Draft clean-up failed");
  } finally {
    running = false;
  }
}

/** Starts the daily timer. The timers never keep the process alive on shutdown. */
export function startDraftCleanupSchedule(): void {
  setTimeout(() => {
    void runDraftCleanup();
    setInterval(() => void runDraftCleanup(), EVERY_MS).unref();
  }, FIRST_RUN_MS).unref();
}

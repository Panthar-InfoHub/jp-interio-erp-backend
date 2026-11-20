import { logger } from "../lib/logger.js";
import { escalateOverdueTasks } from "../services/taskEscalation.service.js";

/**
 * Runs the overdue-task check (DEC-176, DEC-183) inside the server: a few minutes after
 * start-up (catches a night the server was off), then every night at 00:30 India time.
 * Extra runs are harmless (a task is flagged only once).
 *
 * Only works on an always-on server. On a serverless host the timers don't run reliably:
 * use the platform's scheduler to run `npm run job:escalate-tasks` at 00:30 IST (19:00 UTC).
 */

const FIRST_RUN_MS = 5 * 60 * 1000;
/** 00:30 IST = 19:00 UTC (India has no daylight saving). */
const RUN_AT_UTC_HOUR = 19;
const RUN_AT_UTC_MINUTE = 0;

let running = false;

export async function runTaskEscalation(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await escalateOverdueTasks();
    logger.info(result, "Overdue task check finished");
  } catch (error) {
    logger.error({ err: error }, "Overdue task check failed");
  } finally {
    running = false;
  }
}

/** Milliseconds from `now` to the next 00:30 IST. */
export function msUntilNextRun(now: Date = new Date()): number {
  const next = new Date(now);
  next.setUTCHours(RUN_AT_UTC_HOUR, RUN_AT_UTC_MINUTE, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

/** Sets the next nightly run; each run sets the one after it (no drift over time). */
function scheduleNightly(): void {
  setTimeout(() => {
    void runTaskEscalation().finally(scheduleNightly);
  }, msUntilNextRun()).unref();
}

/** Starts the timers. They never keep the process alive on shutdown. */
export function startTaskEscalationSchedule(): void {
  setTimeout(() => void runTaskEscalation(), FIRST_RUN_MS).unref();
  scheduleNightly();
}

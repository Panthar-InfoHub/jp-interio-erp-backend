import { ROLE } from "../config/roles.js";
import type { Prisma } from "../generated/prisma/client.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { dateFromIso, todayInIst } from "../utils/istDate.js";
import { recordAudit } from "./audit.service.js";

/**
 * The daily overdue check (Module 12 T5; DEC-176, DEC-183).
 *
 * Every task that is not finished (open / in progress), whose due day (India date) has
 * passed, and that is not flagged yet, gets flagged ONCE to the doer's direct manager:
 * `escalated_at` + `escalated_to`. The task stays with the doer. If the manager is not
 * active, the flag goes one level higher (and so on up to the Admin).
 *
 * Safe to run any number of times (the server start, the nightly timer, by hand): each task
 * is re-checked under its row lock, so a task is never flagged twice. Each flag writes an
 * audit row with no actor (system).
 */

const STAFF_STEPS_MAX = 10;

type ManagerCache = Map<string, string | null>;

/**
 * The first ACTIVE staff member above this person (their saved manager, else that manager's
 * manager, …). Null if there is none (should not happen: everyone below the Admin has one).
 */
async function activeManagerOf(
  db: Prisma.TransactionClient,
  userId: string,
  cache: ManagerCache
): Promise<string | null> {
  const cached = cache.get(userId);
  if (cached !== undefined) return cached;

  let current = await db.user.findUnique({ where: { id: userId }, select: { parentId: true } });
  let managerId: string | null = null;
  for (let step = 0; step < STAFF_STEPS_MAX && current?.parentId; step += 1) {
    const manager = await db.user.findUnique({
      where: { id: current.parentId },
      select: { id: true, status: true, roleId: true, parentId: true },
    });
    if (!manager) break;
    if (manager.status === "active" && manager.roleId !== ROLE.PARTNER) {
      managerId = manager.id;
      break;
    }
    current = manager;
  }
  cache.set(userId, managerId);
  return managerId;
}

/** Unfinished, due day before `today`, not flagged yet. */
const toFlagWhere = (today: Date): Prisma.TaskWhereInput => ({
  status: { in: ["open", "in_progress"] },
  dueDate: { lt: today },
  escalatedAt: null,
});

export interface EscalationResult {
  /** The India date used as "today". */
  today: string;
  /** Overdue, not-yet-flagged tasks found. */
  found: number;
  flagged: number;
  /** Finished, moved or flagged by another run in the meantime. */
  skipped: number;
  /** No active manager above the doer (left unflagged, logged). */
  noManager: number;
}

/** Ids of the tasks to flag, oldest due first. */
export async function findTasksToFlag(
  db: Prisma.TransactionClient,
  today: Date
): Promise<string[]> {
  const rows = await db.task.findMany({
    where: toFlagWhere(today),
    select: { id: true },
    orderBy: [{ dueDate: "asc" }, { id: "asc" }],
  });
  return rows.map((row) => row.id);
}

export type FlagOutcome = "flagged" | "skipped" | "noManager";

/**
 * Flags one task inside the caller's transaction: locks it, checks again that it still
 * needs a flag, finds the active manager, saves the flag and an audit row.
 */
export async function flagTaskInTx(
  tx: Prisma.TransactionClient,
  taskId: string,
  today: Date,
  cache: ManagerCache = new Map()
): Promise<FlagOutcome> {
  await tx.$queryRaw`SELECT 1 FROM tasks WHERE id = ${taskId}::uuid FOR UPDATE`;
  const task = await tx.task.findFirst({
    where: { AND: [{ id: taskId }, toFlagWhere(today)] },
    select: { id: true, assignedToId: true, dueDate: true, status: true },
  });
  if (!task) return "skipped";

  const managerId = await activeManagerOf(tx, task.assignedToId, cache);
  if (!managerId) {
    logger.warn({ taskId }, "Overdue task not flagged: no active manager above the doer");
    return "noManager";
  }

  const escalatedAt = new Date();
  await tx.task.update({
    where: { id: task.id },
    data: { escalatedAt, escalatedToId: managerId },
  });
  await recordAudit(tx, {
    actorId: null,
    action: "task.escalate",
    entity: { type: "task", id: task.id },
    before: { escalatedAt: null, escalatedToId: null },
    after: {
      escalatedAt,
      escalatedToId: managerId,
      dueDate: task.dueDate.toISOString().slice(0, 10),
      status: task.status,
    },
  });
  return "flagged";
}

/** Runs the check once. `now` is only for tests. */
export async function escalateOverdueTasks(now: Date = new Date()): Promise<EscalationResult> {
  const todayIso = todayInIst(now);
  const today = dateFromIso(todayIso);
  const ids = await findTasksToFlag(prisma, today);

  const result: EscalationResult = {
    today: todayIso,
    found: ids.length,
    flagged: 0,
    skipped: 0,
    noManager: 0,
  };
  const cache: ManagerCache = new Map();

  // One small transaction per task, so one bad row can't undo the others.
  for (const id of ids) {
    const outcome = await prisma.$transaction((tx) => flagTaskInTx(tx, id, today, cache));
    result[outcome] += 1;
  }
  return result;
}

import { TASK_CATEGORY_SUGGESTIONS } from "../config/taskCategories.js";
import { ROLE, ROLES, type RoleId } from "../config/roles.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { PermissionScope } from "../generated/prisma/enums.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { AppError, ConflictError, ForbiddenError } from "../utils/errors.js";
import { dateFromIso, isoFromDate, todayInIst } from "../utils/istDate.js";
import { pageMeta, toPrismaPaging } from "../utils/pagination.js";
import {
  MY_TASK_VIEWS,
  type CancelTaskInput,
  type CompleteTaskInput,
  type CreateTaskInput,
  type MyTaskView,
  type MyTasksQuery,
  type TeamTasksQuery,
  type UpdateTaskInput,
} from "../validators/task.schema.js";
import { recordAudit } from "./audit.service.js";
import { getPermissionScope } from "./permission.service.js";
import { assertInScope, scopeForStaff, scopeForTasks } from "./scope.service.js";
import { verifyUploadedFile } from "./storage.service.js";

/**
 * Field tasks (Module 12; DEC-175 – DEC-181). Every change to a task goes through this file.
 *
 * - Give (T2): only downward, only in scope (`ASSIGNABLE_ROLES` + `scopeForStaff`).
 * - Edit / cancel (T2): the giver and the people above them (`editWhere`), while open or in
 *   progress; a completed task is locked (DEC-177).
 * - Start / complete (T3): only the person the task was given to; Start is optional; late
 *   completion allowed; 1 – 10 checked photos (DEC-181).
 * - People changes (T6): unfinished tasks given to / by someone block switching them off or
 *   moving them (`assertNoOpenTasks`); staff screens show `taskCountsFor` (DEC-184).
 * - Every change locks the rows it depends on first, then writes an audit row in the same
 *   transaction (rule R4). Nothing is ever deleted.
 */

// ---------------------------------------------------------------------------
// Shape sent to the apps
// ---------------------------------------------------------------------------

const PERSON = { select: { id: true, name: true, roleId: true } } as const;

export const TASK_SELECT = {
  id: true,
  title: true,
  description: true,
  category: true,
  priority: true,
  status: true,
  dueDate: true,
  zone: { select: { id: true, name: true } },
  assignedTo: PERSON,
  assignedBy: PERSON,
  startedAt: true,
  completedAt: true,
  completionNote: true,
  cancelledAt: true,
  cancelledBy: PERSON,
  cancelReason: true,
  escalatedAt: true,
  escalatedTo: PERSON,
  photos: {
    select: { id: true, url: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  },
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TaskSelect;

type TaskRow = Prisma.TaskGetPayload<{ select: typeof TASK_SELECT }>;
type PersonRow = { id: string; name: string | null; roleId: number };

const roleKeyOf = (roleId: number) => ROLES.find((role) => role.id === roleId)?.key ?? null;

const toPerson = (person: PersonRow | null) =>
  person ? { id: person.id, name: person.name, role: roleKeyOf(person.roleId) } : null;

/** Not finished yet (open or in progress). */
const isUnfinished = (status: TaskRow["status"]) => status === "open" || status === "in_progress";

/** Overdue = not finished and the due day (India date) has passed (DEC-177). */
export function isOverdue(task: Pick<TaskRow, "status" | "dueDate">, today = todayInIst()) {
  return isUnfinished(task.status) && (isoFromDate(task.dueDate) ?? "") < today;
}

type TaskCore = Pick<
  TaskRow,
  "status" | "dueDate" | "assignedTo" | "assignedBy" | "cancelledBy" | "escalatedTo"
>;

/** Full task (details) or a list row: dates as "YYYY-MM-DD", people with their role key. */
export function toTask<T extends TaskCore>(task: T) {
  return {
    ...task,
    dueDate: isoFromDate(task.dueDate),
    isOverdue: isOverdue(task),
    assignedTo: toPerson(task.assignedTo),
    assignedBy: toPerson(task.assignedBy),
    cancelledBy: toPerson(task.cancelledBy),
    escalatedTo: toPerson(task.escalatedTo),
  };
}

/** List rows: everything except the long description and the photos (count only). */
const TASK_LIST_SELECT = {
  id: true,
  title: true,
  category: true,
  priority: true,
  status: true,
  dueDate: true,
  zone: { select: { id: true, name: true } },
  assignedTo: PERSON,
  assignedBy: PERSON,
  startedAt: true,
  completedAt: true,
  cancelledAt: true,
  cancelledBy: PERSON,
  escalatedAt: true,
  escalatedTo: PERSON,
  createdAt: true,
  _count: { select: { photos: true } },
} satisfies Prisma.TaskSelect;

type TaskListRow = Prisma.TaskGetPayload<{ select: typeof TASK_LIST_SELECT }>;

function toTaskListItem({ _count, ...task }: TaskListRow) {
  return { ...toTask(task), photoCount: _count.photos };
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

/**
 * Locks people's `users` rows, always in id order so two calls never wait on each other in
 * a circle. Switching someone off or moving them (T6) locks the same row, so a task can't
 * be given to a person in the middle of that change.
 */
async function lockUsers(tx: Prisma.TransactionClient, ids: string[]) {
  for (const id of [...new Set(ids)].sort()) {
    await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${id}::uuid FOR UPDATE`;
  }
}

async function lockTask(tx: Prisma.TransactionClient, taskId: string) {
  await tx.$queryRaw`SELECT 1 FROM tasks WHERE id = ${taskId}::uuid FOR UPDATE`;
}

// ---------------------------------------------------------------------------
// T2: categories, give, edit, cancel
// ---------------------------------------------------------------------------

/** GET /api/tasks/categories — the suggested list; any other text is accepted (DEC-177). */
export function listCategorySuggestions() {
  return [...TASK_CATEGORY_SUGGESTIONS];
}

/**
 * Which roles each giver may give a task to (DEC-176, DEC-180). Sales Executives give no
 * tasks. Where in the company is limited separately by `scopeForStaff`:
 * Admin / Tasks Sub-Admin any zone, Zonal Head their zone, ASM themselves + own SEs.
 */
const ASSIGNABLE_ROLES: Partial<Record<RoleId, readonly RoleId[]>> = {
  [ROLE.ADMIN]: [ROLE.SUB_ADMIN, ROLE.ZONAL_HEAD, ROLE.ASM, ROLE.SALES_EXECUTIVE],
  [ROLE.SUB_ADMIN]: [ROLE.ZONAL_HEAD, ROLE.ASM, ROLE.SALES_EXECUTIVE],
  [ROLE.ZONAL_HEAD]: [ROLE.ASM, ROLE.SALES_EXECUTIVE],
  // `scopeForStaff` "own" for an ASM is only themselves and their own Sales Executives.
  [ROLE.ASM]: [ROLE.ASM, ROLE.SALES_EXECUTIVE],
};

/** POST /api/tasks — `tasks.assign`. 404 outside my reach, 403 wrong role, 409 not active. */
export async function createTask(me: AuthUser, scope: PermissionScope, input: CreateTaskInput) {
  return prisma.$transaction(async (tx) => {
    await lockUsers(tx, [me.id, input.assignedToId]);

    const assignee = assertInScope(
      await tx.user.findFirst({
        where: { AND: [{ id: input.assignedToId }, scopeForStaff(me, scope)] },
        select: { id: true, roleId: true, zoneId: true, status: true },
      }),
      { user: me, entity: "staff member", id: input.assignedToId }
    );

    const allowed = ASSIGNABLE_ROLES[me.roleId] ?? [];
    if (!allowed.includes(assignee.roleId as RoleId)) {
      logger.warn(
        { userId: me.id, role: me.roleKey, targetId: assignee.id, targetRoleId: assignee.roleId },
        "Task assignment refused: role not allowed"
      );
      throw new ForbiddenError("You can't give a task to this person");
    }
    if (assignee.status !== "active") {
      throw new ConflictError("This person is not active, so they can't be given a task");
    }

    const task = await tx.task.create({
      data: {
        title: input.title,
        description: input.description,
        category: input.category,
        priority: input.priority,
        dueDate: dateFromIso(input.dueDate),
        assignedToId: assignee.id,
        assignedById: me.id,
        // Fixed at giving time: old tasks stay with this zone (DEC-178).
        zoneId: assignee.zoneId,
      },
      select: TASK_SELECT,
    });

    await recordAudit(tx, {
      actorId: me.id,
      action: "task.create",
      entity: { type: "task", id: task.id },
      after: {
        title: task.title,
        category: task.category,
        priority: task.priority,
        dueDate: input.dueDate,
        assignedToId: assignee.id,
        zoneId: assignee.zoneId,
      },
    });

    return { task: toTask(task) };
  });
}

/**
 * Tasks I may edit or cancel (DEC-180): the giver and the people above them.
 * - Admin: every task.
 * - Tasks Sub-Admin: every task NOT given by the Admin (so also other Sub-Admins' tasks).
 * - Zonal Head: tasks they gave, plus tasks an ASM gave in their zone (the task's zone).
 * - ASM: tasks they gave.
 * - Anyone else: none. The person doing the task can never edit or cancel it.
 */
function editWhere(me: AuthUser): Prisma.TaskWhereInput {
  const none: Prisma.TaskWhereInput = { id: { in: [] } };
  switch (me.roleId) {
    case ROLE.ADMIN:
      return {};
    case ROLE.SUB_ADMIN:
      return { assignedBy: { roleId: { not: ROLE.ADMIN } } };
    case ROLE.ZONAL_HEAD:
      return {
        OR: [
          { assignedById: me.id },
          ...(me.zoneId ? [{ zoneId: me.zoneId, assignedBy: { roleId: ROLE.ASM } }] : []),
        ],
      };
    case ROLE.ASM:
      return { assignedById: me.id };
    default:
      return none;
  }
}

/** Locks the task, then loads it only if I may edit / cancel it (else 404). */
async function loadForChange(tx: Prisma.TransactionClient, me: AuthUser, taskId: string) {
  await lockTask(tx, taskId);
  return assertInScope(
    await tx.task.findFirst({
      where: { AND: [{ id: taskId }, editWhere(me)] },
      select: TASK_SELECT,
    }),
    { user: me, entity: "task", id: taskId }
  );
}

function assertNotFinished(task: TaskRow) {
  if (task.status === "completed") {
    throw new ConflictError("This task is completed, so it can't be changed");
  }
  if (task.status === "cancelled") {
    throw new ConflictError("This task is cancelled, so it can't be changed");
  }
}

/**
 * PATCH /api/tasks/:id — title, description, category, priority, due date (DEC-177, DEC-180).
 * - Only while open or in progress (409 otherwise).
 * - A new due date must be today or later; it also clears the overdue mark (DEC-180).
 * - Nothing actually different → `changed: false`, no audit row.
 */
export async function updateTask(me: AuthUser, taskId: string, input: UpdateTaskInput) {
  return prisma.$transaction(async (tx) => {
    const task = await loadForChange(tx, me, taskId);
    assertNotFinished(task);

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const data: Prisma.TaskUpdateInput = {};

    const note = (field: string, oldValue: unknown, newValue: unknown) => {
      before[field] = oldValue;
      after[field] = newValue;
    };

    if (input.title !== undefined && input.title !== task.title) {
      data.title = input.title;
      note("title", task.title, input.title);
    }
    if (input.description !== undefined && input.description !== task.description) {
      data.description = input.description;
      note("description", task.description, input.description);
    }
    if (input.category !== undefined && input.category !== task.category) {
      data.category = input.category;
      note("category", task.category, input.category);
    }
    if (input.priority !== undefined && input.priority !== task.priority) {
      data.priority = input.priority;
      note("priority", task.priority, input.priority);
    }

    const oldDue = isoFromDate(task.dueDate);
    if (input.dueDate !== undefined && input.dueDate !== oldDue) {
      if (input.dueDate < todayInIst()) {
        throw new ConflictError("The new due date can't be in the past");
      }
      data.dueDate = dateFromIso(input.dueDate);
      note("dueDate", oldDue, input.dueDate);
      // A new date removes the overdue mark; the daily check marks it again if this one
      // also passes (DEC-180).
      if (task.escalatedAt) {
        data.escalatedAt = null;
        data.escalatedTo = { disconnect: true };
        note("escalatedAt", task.escalatedAt, null);
        note("escalatedToId", task.escalatedTo?.id ?? null, null);
      }
    }

    if (Object.keys(after).length === 0) {
      return { changed: false, task: toTask(task) };
    }

    const updated = await tx.task.update({ where: { id: task.id }, data, select: TASK_SELECT });
    await recordAudit(tx, {
      actorId: me.id,
      action: "task.update",
      entity: { type: "task", id: task.id },
      before,
      after,
    });
    return { changed: true, task: toTask(updated) };
  });
}

/**
 * POST /api/tasks/:id/cancel — reason 10 – 500 (DEC-177, DEC-180). Only while open or in
 * progress; completed → 409. Already cancelled → no change (`alreadyDone`). Never deleted.
 */
export async function cancelTask(me: AuthUser, taskId: string, input: CancelTaskInput) {
  return prisma.$transaction(async (tx) => {
    const task = await loadForChange(tx, me, taskId);
    if (task.status === "cancelled") {
      return { alreadyDone: true, task: toTask(task) };
    }
    assertNotFinished(task);

    const updated = await tx.task.update({
      where: { id: task.id },
      data: {
        status: "cancelled",
        cancelledAt: new Date(),
        cancelledBy: { connect: { id: me.id } },
        cancelReason: input.reason,
      },
      select: TASK_SELECT,
    });
    await recordAudit(tx, {
      actorId: me.id,
      action: "task.cancel",
      entity: { type: "task", id: task.id },
      before: { status: task.status },
      after: { status: "cancelled", reason: input.reason },
    });
    return { alreadyDone: false, task: toTask(updated) };
  });
}

// ---------------------------------------------------------------------------
// T3: the person doing the task — start, complete (DEC-181)
// ---------------------------------------------------------------------------

/** Only tasks given to me; anyone else (even the giver) gets 404 here. */
const doerWhere = (me: AuthUser): Prisma.TaskWhereInput => ({ assignedToId: me.id });

/** Locks the task, then loads it only if it was given to me (else 404). */
async function loadMine(tx: Prisma.TransactionClient, me: AuthUser, taskId: string) {
  await lockTask(tx, taskId);
  return assertInScope(
    await tx.task.findFirst({
      where: { AND: [{ id: taskId }, doerWhere(me)] },
      select: TASK_SELECT,
    }),
    { user: me, entity: "task", id: taskId }
  );
}

/**
 * POST /api/tasks/:id/start — open → in progress, time saved. Optional step (DEC-181).
 * Already in progress → no change (`alreadyDone`). Completed / cancelled → 409.
 */
export async function startTask(me: AuthUser, taskId: string) {
  return prisma.$transaction(async (tx) => {
    const task = await loadMine(tx, me, taskId);
    if (task.status === "in_progress") {
      return { alreadyDone: true, task: toTask(task) };
    }
    assertNotFinished(task);

    const updated = await tx.task.update({
      where: { id: task.id },
      data: { status: "in_progress", startedAt: new Date() },
      select: TASK_SELECT,
    });
    await recordAudit(tx, {
      actorId: me.id,
      action: "task.start",
      entity: { type: "task", id: task.id },
      before: { status: task.status },
      after: { status: "in_progress" },
    });
    return { alreadyDone: false, task: toTask(updated) };
  });
}

/**
 * POST /api/tasks/:id/complete — from open or in progress, with 1 – 10 photos and an
 * optional note (DEC-177, DEC-181). Late is fine: the overdue mark stays as history.
 * - Each photo must be the person's own uploaded `task_photo` (checked in storage before
 *   the transaction, as for request receipts).
 * - Already completed → no change (`alreadyDone`), so a repeated tap is harmless.
 *   Cancelled → 409. After this the task is locked.
 */
export async function completeTask(me: AuthUser, taskId: string, input: CompleteTaskInput) {
  // Cheap check first, so photos aren't checked (or bad ones deleted) for a task that isn't
  // mine or is already finished. Checked again under the lock below.
  const current = assertInScope(
    await prisma.task.findFirst({
      where: { AND: [{ id: taskId }, doerWhere(me)] },
      select: TASK_SELECT,
    }),
    { user: me, entity: "task", id: taskId }
  );
  if (current.status === "completed") {
    return { alreadyDone: true, task: toTask(current) };
  }
  assertNotFinished(current);

  for (const [index, url] of input.photoUrls.entries()) {
    await verifyUploadedFile(me, "task_photo", url, `photo ${index + 1}`);
  }

  return prisma.$transaction((tx) => completeTaskInTx(tx, me, taskId, input));
}

// ---------------------------------------------------------------------------
// T4: lists and details (DEC-182). Read only.
// ---------------------------------------------------------------------------

export const UNFINISHED: Prisma.TaskWhereInput = { status: { in: ["open", "in_progress"] } };

/** Unfinished and the due day (India date) has passed. `today` = midnight UTC of the IST day. */
const overdueWhere = (today: Date): Prisma.TaskWhereInput => ({
  ...UNFINISHED,
  dueDate: { lt: today },
});

function myViewWhere(view: MyTaskView, today: Date): Prisma.TaskWhereInput {
  switch (view) {
    case "unfinished":
      return UNFINISHED;
    case "today":
      return { ...UNFINISHED, dueDate: today };
    case "upcoming":
      return { ...UNFINISHED, dueDate: { gt: today } };
    case "overdue":
      return overdueWhere(today);
    case "completed":
      return { status: "completed" };
    case "cancelled":
      return { status: "cancelled" };
  }
}

/**
 * Soonest due first, then high → medium → low (the enum's own order), DEC-182.
 * Finished views: newest first.
 */
function myViewOrder(view: MyTaskView): Prisma.TaskOrderByWithRelationInput[] {
  switch (view) {
    case "completed":
      return [{ completedAt: "desc" }, { id: "desc" }];
    case "cancelled":
      return [{ cancelledAt: "desc" }, { id: "desc" }];
    default:
      return [{ dueDate: "asc" }, { priority: "asc" }, { createdAt: "asc" }, { id: "asc" }];
  }
}

/**
 * GET /api/tasks/mine — tasks given to me, one filter at a time (`view`, default
 * unfinished), plus a count for every view (for badges). DEC-182.
 */
export async function listMyTasks(
  me: AuthUser,
  query: MyTasksQuery,
  db: Prisma.TransactionClient = prisma
) {
  const today = dateFromIso(todayInIst());
  const mine: Prisma.TaskWhereInput = { assignedToId: me.id };
  const [rows, ...viewCounts] = await Promise.all([
    db.task.findMany({
      where: { AND: [mine, myViewWhere(query.view, today)] },
      orderBy: myViewOrder(query.view),
      ...toPrismaPaging(query.page, query.limit),
      select: TASK_LIST_SELECT,
    }),
    ...MY_TASK_VIEWS.map((view) =>
      db.task.count({ where: { AND: [mine, myViewWhere(view, today)] } })
    ),
  ]);
  const counts = Object.fromEntries(
    MY_TASK_VIEWS.map((view, index) => [view, viewCounts[index] ?? 0])
  ) as Record<MyTaskView, number>;
  return {
    counts,
    items: rows.map(toTaskListItem),
    meta: pageMeta(query.page, query.limit, counts[query.view]),
  };
}

/** Sort for the team list; tasks not completed yet go last when sorting by completion. */
function teamOrder(sort: TeamTasksQuery["sort"]): Prisma.TaskOrderByWithRelationInput[] {
  const direction = sort.startsWith("-") ? "desc" : "asc";
  const field = sort.replace(/^-/, "") as "createdAt" | "dueDate" | "completedAt";
  const first: Prisma.TaskOrderByWithRelationInput =
    field === "completedAt"
      ? { completedAt: { sort: direction, nulls: "last" } }
      : { [field]: direction };
  return [first, { id: direction }];
}

/** GET /api/tasks — tasks in my `tasks.view` scope, with filters (DEC-182). */
export async function listTeamTasks(
  me: AuthUser,
  scope: PermissionScope,
  query: TeamTasksQuery,
  db: Prisma.TransactionClient = prisma
) {
  const today = dateFromIso(todayInIst());
  const contains = (text: string) => ({ contains: text, mode: "insensitive" as const });
  const where: Prisma.TaskWhereInput = {
    AND: [
      scopeForTasks(me, scope),
      ...(query.status === "unfinished" ? [UNFINISHED] : []),
      {
        ...(query.status && query.status !== "unfinished" && { status: query.status }),
        ...(query.priority && { priority: query.priority }),
        ...(query.category && { category: { equals: query.category, mode: "insensitive" } }),
        ...(query.assignedToId && { assignedToId: query.assignedToId }),
        ...(query.assignedById && { assignedById: query.assignedById }),
        ...(query.zoneId && { zoneId: query.zoneId }),
        ...((query.dueFrom || query.dueTo) && {
          dueDate: {
            ...(query.dueFrom && { gte: dateFromIso(query.dueFrom) }),
            ...(query.dueTo && { lte: dateFromIso(query.dueTo) }),
          },
        }),
        ...(query.escalatedToMe && { escalatedToId: me.id }),
      },
      ...(query.overdue === true ? [overdueWhere(today)] : []),
      ...(query.overdue === false ? [{ NOT: overdueWhere(today) }] : []),
      ...(query.search
        ? [
            {
              OR: [
                { title: contains(query.search) },
                { assignedTo: { name: contains(query.search) } },
                { assignedBy: { name: contains(query.search) } },
              ],
            },
          ]
        : []),
    ],
  };
  const [rows, total] = await Promise.all([
    db.task.findMany({
      where,
      orderBy: teamOrder(query.sort),
      ...toPrismaPaging(query.page, query.limit),
      select: TASK_LIST_SELECT,
    }),
    db.task.count({ where }),
  ]);
  return { items: rows.map(toTaskListItem), meta: pageMeta(query.page, query.limit, total) };
}

/**
 * GET /api/tasks/:id — full details with photos. Visible if it is in my `tasks.view` scope,
 * or it was given to me (so every Sub-Admin can open their own tasks). Else 404; someone
 * with neither permission (a partner) → 403.
 */
export async function getTask(me: AuthUser, taskId: string, db: Prisma.TransactionClient = prisma) {
  const [viewScope, doScope] = await Promise.all([
    getPermissionScope(me, "tasks.view"),
    getPermissionScope(me, "tasks.complete"),
  ]);
  if (!viewScope && !doScope) {
    logger.warn({ userId: me.id, role: me.roleKey }, "Task details refused: no task permission");
    throw new ForbiddenError();
  }
  const visible: Prisma.TaskWhereInput[] = [
    ...(viewScope ? [scopeForTasks(me, viewScope)] : []),
    ...(doScope ? [{ assignedToId: me.id }] : []),
  ];
  const task = assertInScope(
    await db.task.findFirst({
      where: { AND: [{ id: taskId }, { OR: visible }] },
      select: TASK_SELECT,
    }),
    { user: me, entity: "task", id: taskId }
  );
  return toTask(task);
}

// ---------------------------------------------------------------------------
// T6: people changes and staff screens (DEC-184)
// ---------------------------------------------------------------------------

/** 409 for a people change that unfinished tasks block (DEC-184). */
export class OpenTasksError extends AppError {
  constructor(message: string, openTasks: number) {
    super(message, 409, "OPEN_TASKS", { openTasks });
  }
}

/**
 * Unfinished tasks given TO or BY this person, inside the caller's transaction. Locks the
 * person's `users` row first — giving a task locks the same row (`createTask`) — so a task
 * can't slip in between this count and the caller's change.
 */
export async function countOpenTasksOf(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
  return tx.task.count({
    where: { AND: [UNFINISHED, { OR: [{ assignedToId: userId }, { assignedById: userId }] }] },
  });
}

/**
 * Refuses a switch-off / move / Zonal Head replacement while the person has unfinished tasks
 * (DEC-184). `who` starts the message, e.g. "This Sales Executive".
 */
export async function assertNoOpenTasks(
  tx: Prisma.TransactionClient,
  userId: string,
  who: string
): Promise<void> {
  const openTasks = await countOpenTasksOf(tx, userId);
  if (openTasks > 0) {
    throw new OpenTasksError(
      `${who} has ${openTasks} unfinished task(s), given to them or given by them. ` +
        "They must be completed or cancelled first.",
      openTasks
    );
  }
}

export interface TaskCounts {
  /** Given to them, not finished. */
  pending: number;
  /** Given to them, not finished, due day passed. */
  overdue: number;
  /** Given by them to others (or themselves), not finished. */
  givenOpen: number;
}

/** Task numbers for staff screens (DEC-184), for several people at once. */
export async function taskCountsFor(
  userIds: string[],
  db: Prisma.TransactionClient = prisma
): Promise<Map<string, TaskCounts>> {
  const today = dateFromIso(todayInIst());
  const [pending, overdue, given] = await Promise.all([
    db.task.groupBy({
      by: ["assignedToId"],
      where: { AND: [UNFINISHED, { assignedToId: { in: userIds } }] },
      _count: { _all: true },
    }),
    db.task.groupBy({
      by: ["assignedToId"],
      where: { AND: [overdueWhere(today), { assignedToId: { in: userIds } }] },
      _count: { _all: true },
    }),
    db.task.groupBy({
      by: ["assignedById"],
      where: { AND: [UNFINISHED, { assignedById: { in: userIds } }] },
      _count: { _all: true },
    }),
  ]);
  return new Map(
    userIds.map((id) => [
      id,
      {
        pending: pending.find((row) => row.assignedToId === id)?._count._all ?? 0,
        overdue: overdue.find((row) => row.assignedToId === id)?._count._all ?? 0,
        givenOpen: given.find((row) => row.assignedById === id)?._count._all ?? 0,
      },
    ])
  );
}

/**
 * The saving part of completing a task, inside the caller's transaction. The photo links
 * must already be checked (`completeTask` does that first).
 */
export async function completeTaskInTx(
  tx: Prisma.TransactionClient,
  me: AuthUser,
  taskId: string,
  input: CompleteTaskInput
) {
  const task = await loadMine(tx, me, taskId);
  if (task.status === "completed") {
    return { alreadyDone: true, task: toTask(task) };
  }
  assertNotFinished(task);

  const completedAt = new Date();
  await tx.taskPhoto.createMany({
    data: input.photoUrls.map((url) => ({ taskId: task.id, url, uploadedById: me.id })),
  });
  const updated = await tx.task.update({
    where: { id: task.id },
    data: { status: "completed", completedAt, completionNote: input.note },
    select: TASK_SELECT,
  });
  await recordAudit(tx, {
    actorId: me.id,
    action: "task.complete",
    entity: { type: "task", id: task.id },
    before: { status: task.status },
    after: {
      status: "completed",
      photos: input.photoUrls.length,
      note: input.note,
      late: isOverdue(task, todayInIst(completedAt)),
    },
  });
  return { alreadyDone: false, task: toTask(updated) };
}

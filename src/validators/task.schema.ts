import { z } from "zod";
import { todayInIst } from "../utils/istDate.js";
import { listQuery } from "../utils/pagination.js";
import { idParams } from "./common.js";
import { requestReason } from "./request.schema.js";

/**
 * Field tasks (Module 12; DEC-175 – DEC-180). Limits match the `tasks` table (DEC-178):
 * title 1 – 300 (required), description up to 5,000 (optional), category 1 – 100 (free text,
 * DEC-177). Due date is a day only, today or later in India time (DEC-180).
 */
export const TASK_TITLE_MAX = 300;
export const TASK_DESCRIPTION_MAX = 5000;
export const TASK_CATEGORY_MAX = 100;

export const taskPriority = z.enum(["high", "medium", "low"], {
  message: "priority must be high, medium or low",
});

const title = z
  .string({ message: "title is required" })
  .trim()
  .min(1, "title is required")
  .max(TASK_TITLE_MAX, `title can be at most ${TASK_TITLE_MAX} characters`);

const category = z
  .string({ message: "category is required" })
  .trim()
  .transform((value) => value.replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(1, "category is required")
      .max(TASK_CATEGORY_MAX, `category can be at most ${TASK_CATEGORY_MAX} characters`)
  );

/** Empty text counts as "no description". */
const description = z
  .string({ message: "description must be text" })
  .trim()
  .max(TASK_DESCRIPTION_MAX, `description can be at most ${TASK_DESCRIPTION_MAX} characters`)
  .transform((value) => (value ? value : null));

/** "YYYY-MM-DD" only; whether it may be in the past is decided where it is used. */
const dueDateFormat = z.iso.date("dueDate must be a date like 2026-12-01");

/**
 * POST /api/tasks (T2). Who may be given the task is checked by the service (DEC-176,
 * DEC-180): Admin → Zonal Heads, Sub-Admins, ASMs, Sales Executives; Tasks Sub-Admin →
 * Zonal Heads, ASMs, Sales Executives; Zonal Head → ASMs and Sales Executives in their zone;
 * ASM → themselves and their own Sales Executives.
 */
export const createTaskSchemas = {
  body: z.object({
    assignedToId: z.uuid("Invalid assignedToId"),
    title,
    description: description.optional().transform((value) => value ?? null),
    category,
    priority: taskPriority.default("medium"),
    dueDate: dueDateFormat.refine((value) => value >= todayInIst(), {
      message: "dueDate can't be in the past",
    }),
  }),
};
export type CreateTaskInput = z.output<typeof createTaskSchemas.body>;

/** GET /api/tasks/:id and the other `/:id` routes. */
export const taskIdSchemas = { params: idParams };

/**
 * PATCH /api/tasks/:id (T2) — send only what changes; at least one field. `description: null`
 * (or "") clears it. A NEW due date must be today or later (checked by the service, which
 * knows the old one, so an unchanged overdue date can be sent back as it is). The person who
 * does the task can't be changed (DEC-175).
 */
export const updateTaskSchemas = {
  params: idParams,
  body: z
    .object({
      title: title.optional(),
      description: description.nullable().optional(),
      category: category.optional(),
      priority: taskPriority.optional(),
      dueDate: dueDateFormat.optional(),
    })
    .refine((body) => Object.values(body).some((value) => value !== undefined), {
      message: "Send at least one field to change",
    }),
};
export type UpdateTaskInput = z.output<typeof updateTaskSchemas.body>;

/** Photos per completed task (DEC-177). */
export const TASK_PHOTOS_MIN = 1;
export const TASK_PHOTOS_MAX = 10;
/** Matches `tasks.completion_note` (VarChar(2000)); optional (DEC-177). */
export const TASK_NOTE_MAX = 2000;

/**
 * POST /api/tasks/:id/complete (T3, DEC-181) — only the person the task was given to.
 * - `photoUrls`: 1 – 10 `fileUrl`s from upload links with purpose `task_photo`, no repeats.
 *   Each one is checked by the server (ours, theirs, a real image, 5 MB at most).
 * - `note`: optional, up to 2,000 characters. Empty text counts as no note.
 */
export const completeTaskSchemas = {
  params: idParams,
  body: z.object({
    photoUrls: z
      .array(z.url("Each photo must be the fileUrl from the upload link").max(1000), {
        message: "photoUrls must be a list",
      })
      .min(TASK_PHOTOS_MIN, "Add at least one photo")
      .max(TASK_PHOTOS_MAX, `At most ${TASK_PHOTOS_MAX} photos`)
      .refine((urls) => new Set(urls).size === urls.length, {
        message: "The same photo is in the list twice",
      }),
    note: z
      .string({ message: "note must be text" })
      .trim()
      .max(TASK_NOTE_MAX, `note can be at most ${TASK_NOTE_MAX} characters`)
      .optional()
      .transform((value) => (value ? value : null)),
  }),
};
export type CompleteTaskInput = z.output<typeof completeTaskSchemas.body>;

/** POST /api/tasks/:id/start — nothing to send. */
export const startTaskSchemas = { params: idParams };

// ---- T4: lists (DEC-182) ----

export const TASK_STATUSES = ["open", "in_progress", "completed", "cancelled"] as const;
const taskStatus = z.enum(TASK_STATUSES, {
  message: `status must be one of: ${TASK_STATUSES.join(", ")}`,
});

/** "My tasks" filters. `unfinished` (default) = today + upcoming + overdue (DEC-182). */
export const MY_TASK_VIEWS = [
  "unfinished",
  "today",
  "upcoming",
  "overdue",
  "completed",
  "cancelled",
] as const;
export type MyTaskView = (typeof MY_TASK_VIEWS)[number];

/** `?flag=true` / `?flag=false`; anything else is a 400. */
const yesNo = (label: string) =>
  z
    .enum(["true", "false"], { message: `${label} must be true or false` })
    .transform((value) => value === "true");

/** Page and limit only: each view has its own fixed order (DEC-182). */
const pageOnly = listQuery({ sortFields: ["dueDate"], defaultSort: "dueDate" }).omit({
  sort: true,
});

/**
 * GET /api/tasks/mine — tasks given to me, one list with a filter (DEC-182):
 * unfinished (default) / today / upcoming / overdue: soonest due first, then high → low;
 * completed: newest completed first; cancelled: newest cancelled first.
 */
export const myTasksSchemas = {
  query: pageOnly.extend({
    view: z
      .enum(MY_TASK_VIEWS, { message: `view must be one of: ${MY_TASK_VIEWS.join(", ")}` })
      .default("unfinished"),
  }),
};
export type MyTasksQuery = z.output<typeof myTasksSchemas.query>;

/**
 * GET /api/tasks — tasks in my scope (`tasks.view`, DEC-182), newest first by default.
 * - `assignedToId` / `assignedById` / `zoneId`: one person / zone.
 * - `dueFrom` / `dueTo`: "YYYY-MM-DD", both included.
 * - `overdue=true`: unfinished and the due day has passed.
 * - `escalatedToMe=true`: flagged to me by the daily overdue check (DEC-176).
 * - `search`: part of the title, or of the doer's or giver's name.
 */
export const teamTasksSchemas = {
  query: listQuery({
    sortFields: ["createdAt", "dueDate", "completedAt"],
    defaultSort: "-createdAt",
  })
    .extend({
      status: taskStatus.optional(),
      priority: taskPriority.optional(),
      category: z.string().trim().min(1).max(TASK_CATEGORY_MAX).optional(),
      assignedToId: z.uuid("Invalid assignedToId").optional(),
      assignedById: z.uuid("Invalid assignedById").optional(),
      zoneId: z.uuid("Invalid zoneId").optional(),
      dueFrom: dueDateFormat.optional(),
      dueTo: dueDateFormat.optional(),
      overdue: yesNo("overdue").optional(),
      escalatedToMe: yesNo("escalatedToMe").optional(),
      search: z.string().trim().min(1).max(100).optional(),
    })
    .refine((query) => !query.dueFrom || !query.dueTo || query.dueFrom <= query.dueTo, {
      message: "dueFrom must be on or before dueTo",
      path: ["dueTo"],
    }),
};
export type TeamTasksQuery = z.output<typeof teamTasksSchemas.query>;

/** POST /api/tasks/:id/cancel — reason 10 – 500, same rule as requests (DEC-180). */
export const cancelTaskSchemas = {
  params: idParams,
  body: z.object({ reason: requestReason }),
};
export type CancelTaskInput = z.output<typeof cancelTaskSchemas.body>;

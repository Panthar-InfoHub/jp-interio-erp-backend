import { getAuthUser } from "../middlewares/auth.js";
import { getScope } from "../middlewares/permission.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import * as taskService from "../services/task.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import type {
  cancelTaskSchemas,
  completeTaskSchemas,
  createTaskSchemas,
  myTasksSchemas,
  startTaskSchemas,
  taskIdSchemas,
  teamTasksSchemas,
  updateTaskSchemas,
} from "../validators/task.schema.js";

/** GET /api/tasks/mine — tasks given to me, one view at a time, with counts per view (T4). */
export const mine = asyncHandler<ValidatedRequest<typeof myTasksSchemas>>(async (req, res) => {
  const { counts, items, meta } = await taskService.listMyTasks(getAuthUser(req), req.query);
  sendSuccess(res, 200, { counts, items }, undefined, meta);
});

/** GET /api/tasks — tasks in my scope, with filters (T4). */
export const team = asyncHandler<ValidatedRequest<typeof teamTasksSchemas>>(async (req, res) => {
  const { items, meta } = await taskService.listTeamTasks(
    getAuthUser(req),
    getScope(req),
    req.query
  );
  sendSuccess(res, 200, items, undefined, meta);
});

/** GET /api/tasks/:id — full details with photos (T4). */
export const detail = asyncHandler<ValidatedRequest<typeof taskIdSchemas>>(async (req, res) => {
  sendSuccess(res, 200, await taskService.getTask(getAuthUser(req), req.params.id));
});

/** GET /api/tasks/categories — suggested categories; any other text is accepted (DEC-177). */
export const categories = asyncHandler(async (_req, res) => {
  sendSuccess(res, 200, taskService.listCategorySuggestions());
});

/** POST /api/tasks — give a task to someone below me (Module 12 T2). */
export const create = asyncHandler<ValidatedRequest<typeof createTaskSchemas>>(async (req, res) => {
  const result = await taskService.createTask(getAuthUser(req), getScope(req), req.body);
  sendSuccess(res, 201, result, "Task given");
});

/** PATCH /api/tasks/:id — the giver (or someone above them) edits it, until completed. */
export const update = asyncHandler<ValidatedRequest<typeof updateTaskSchemas>>(async (req, res) => {
  const result = await taskService.updateTask(getAuthUser(req), req.params.id, req.body);
  sendSuccess(res, 200, result, result.changed ? "Task updated" : "Nothing to change");
});

/** POST /api/tasks/:id/cancel — reason required; never deleted. */
export const cancel = asyncHandler<ValidatedRequest<typeof cancelTaskSchemas>>(async (req, res) => {
  const result = await taskService.cancelTask(getAuthUser(req), req.params.id, req.body);
  sendSuccess(
    res,
    200,
    result,
    result.alreadyDone ? "This task was already cancelled" : "Task cancelled"
  );
});

/** POST /api/tasks/:id/start — the person doing it; optional step (Module 12 T3). */
export const start = asyncHandler<ValidatedRequest<typeof startTaskSchemas>>(async (req, res) => {
  const result = await taskService.startTask(getAuthUser(req), req.params.id);
  sendSuccess(
    res,
    200,
    result,
    result.alreadyDone ? "This task is already started" : "Task started"
  );
});

/** POST /api/tasks/:id/complete — 1 – 10 photos, optional note; then locked (Module 12 T3). */
export const complete = asyncHandler<ValidatedRequest<typeof completeTaskSchemas>>(
  async (req, res) => {
    const result = await taskService.completeTask(getAuthUser(req), req.params.id, req.body);
    sendSuccess(
      res,
      200,
      result,
      result.alreadyDone ? "This task was already completed" : "Task completed"
    );
  }
);

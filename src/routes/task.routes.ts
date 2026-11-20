import { Router } from "express";
import * as taskController from "../controllers/task.controller.js";
import { requireAuth } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import {
  cancelTaskSchemas,
  completeTaskSchemas,
  createTaskSchemas,
  myTasksSchemas,
  startTaskSchemas,
  taskIdSchemas,
  teamTasksSchemas,
  updateTaskSchemas,
} from "../validators/task.schema.js";

/**
 * Field tasks (Module 12). Mounted at `/tasks`.
 *
 * T2 — the giver's side, `tasks.assign` (Admin, Tasks Sub-Admin, Zonal Head, ASM):
 * give, edit, cancel. Who may be given a task and who may edit / cancel it is checked by
 * task.service.ts (DEC-176, DEC-180). Out of reach → 404.
 * T3 — the person the task was given to, `tasks.complete`: start, complete (DEC-181).
 * T4 — lists and details (DEC-182).
 */
const router = Router();

const assign = [requireAuth, requirePermission("tasks.assign")];
const doer = [requireAuth, requirePermission("tasks.complete")];

// Fixed paths before any "/:id" route, so "categories" / "mine" aren't read as ids.
router.get("/categories", ...assign, taskController.categories);
// Tasks given to me (Sub-Admin, Zonal Head, ASM, Sales Executive).
router.get("/mine", ...doer, validate(myTasksSchemas), taskController.mine);
// Tasks in my scope: Admin / Tasks Sub-Admin all, Zonal Head zone, ASM team, SE own.
router.get(
  "/",
  requireAuth,
  requirePermission("tasks.view"),
  validate(teamTasksSchemas),
  taskController.team
);
// Details: in my `tasks.view` scope, or given to me (checked by the service).
router.get("/:id", requireAuth, validate(taskIdSchemas), taskController.detail);

router.post("/", ...assign, validate(createTaskSchemas), taskController.create);
router.patch("/:id", ...assign, validate(updateTaskSchemas), taskController.update);
router.post("/:id/cancel", ...assign, validate(cancelTaskSchemas), taskController.cancel);

router.post("/:id/start", ...doer, validate(startTaskSchemas), taskController.start);
router.post("/:id/complete", ...doer, validate(completeTaskSchemas), taskController.complete);

export default router;

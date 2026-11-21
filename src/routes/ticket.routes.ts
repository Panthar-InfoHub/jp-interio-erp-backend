import { Router } from "express";
import * as ticketController from "../controllers/ticket.controller.js";
import { requireApp, requireAuth } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import {
  changeTicketStatusSchemas,
  ticketIdSchemas,
  ticketQueueSchemas,
} from "../validators/ticket.schema.js";

/**
 * Support tickets, the Admin side (Module 15 T3, DEC-193). Mounted at `/tickets`.
 * Only the Admin has `tickets.handle` (DEC-020); web console only. The partner side is in
 * partnerSelf.routes.ts (`/partner/tickets`).
 */
const router = Router();

router.use(requireAuth, requireApp("web"), requirePermission("tickets.handle"));

router.get("/", validate(ticketQueueSchemas), ticketController.queue);
router.get("/:id", validate(ticketIdSchemas), ticketController.detail);
router.post("/:id/status", validate(changeTicketStatusSchemas), ticketController.changeStatus);

export default router;

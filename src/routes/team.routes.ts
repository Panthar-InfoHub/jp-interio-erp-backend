import { Router } from "express";
import { ROLE } from "../config/roles.js";
import * as teamController from "../controllers/team.controller.js";
import { requireAuth, requireRole } from "../middlewares/auth.js";

/** ASM "My Team" (DEC-068). ASMs only; everyone else gets 403. */
const router = Router();

router.get("/", requireAuth, requireRole(ROLE.ASM), teamController.getMyTeam);

export default router;

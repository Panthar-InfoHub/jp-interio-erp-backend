import { Router } from "express";
import * as orgController from "../controllers/org.controller.js";
import { requireAuth } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";

/** Org tree (DEC-070). `users.view`: Admin all, Zonal Head their zone, ASM their team. */
const router = Router();

router.get("/tree", requireAuth, requirePermission("users.view"), orgController.getTree);

export default router;

import { Router } from "express";
import { isProd } from "../config/env.js";
import authRoutes from "./auth.routes.js";
import devRoutes from "./dev.routes.js";
import settingsRoutes from "./settings.routes.js";
import subAdminRoutes from "./subAdmin.routes.js";

const router = Router();

// Each new feature adds one line here:
router.use("/auth", authRoutes);
router.use("/sub-admins", subAdminRoutes);
router.use("/settings", settingsRoutes);

// Development-only tools (DEC-050). Never available in production.
if (!isProd) router.use("/dev", devRoutes);

export default router;

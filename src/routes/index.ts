import { Router } from "express";
import authRoutes from "./auth.routes.js";

const router = Router();

// Each new feature adds one line here:
router.use("/auth", authRoutes);

export default router;

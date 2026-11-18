import { Router } from "express";
import { isProd } from "../config/env.js";
import authRoutes from "./auth.routes.js";
import devRoutes from "./dev.routes.js";
import fieldOnboardingRoutes from "./fieldOnboarding.routes.js";
import kycRoutes from "./kyc.routes.js";
import onboardingRoutes from "./onboarding.routes.js";
import orgRoutes from "./org.routes.js";
import partnerRoutes from "./partner.routes.js";
import partnerSelfRoutes from "./partnerSelf.routes.js";
import settingsRoutes from "./settings.routes.js";
import subAdminRoutes from "./subAdmin.routes.js";
import teamRoutes from "./team.routes.js";
import uploadRoutes from "./upload.routes.js";
import userRoutes from "./user.routes.js";
import zoneRoutes from "./zone.routes.js";

const router = Router();

// Each new feature adds one line here:
router.use("/auth", authRoutes);
router.use("/sub-admins", subAdminRoutes);
router.use("/settings", settingsRoutes);
router.use("/zones", zoneRoutes);
router.use("/users", userRoutes);
router.use("/team", teamRoutes);
router.use("/partners", partnerRoutes);
router.use("/org", orgRoutes);
router.use("/uploads", uploadRoutes);
router.use("/partner/onboarding", onboardingRoutes);
router.use("/partner", partnerSelfRoutes);
router.use("/field/onboarding", fieldOnboardingRoutes);
router.use("/kyc", kycRoutes);

// Development-only tools (DEC-050). Never available in production.
if (!isProd) router.use("/dev", devRoutes);

export default router;

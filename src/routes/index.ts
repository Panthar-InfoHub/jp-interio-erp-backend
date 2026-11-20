import { Router } from "express";
import { isProd } from "../config/env.js";
import authRoutes from "./auth.routes.js";
import brandRoutes from "./brand.routes.js";
import catalogRoutes from "./catalog.routes.js";
import categoryRoutes from "./category.routes.js";
import devRoutes from "./dev.routes.js";
import fieldOnboardingRoutes from "./fieldOnboarding.routes.js";
import kycRoutes from "./kyc.routes.js";
import ledgerRoutes from "./ledger.routes.js";
import onboardingRoutes from "./onboarding.routes.js";
import orgRoutes from "./org.routes.js";
import partnerRoutes from "./partner.routes.js";
import partnerSelfRoutes from "./partnerSelf.routes.js";
import payoutRoutes from "./payout.routes.js";
import productRoutes from "./product.routes.js";
import qrRoutes from "./qr.routes.js";
import reportRoutes from "./report.routes.js";
import requestRoutes from "./request.routes.js";
import settingsRoutes from "./settings.routes.js";
import subAdminRoutes from "./subAdmin.routes.js";
import taskRoutes from "./task.routes.js";
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
router.use("/brands", brandRoutes);
router.use("/categories", categoryRoutes);
router.use("/products", productRoutes);
router.use("/catalog", catalogRoutes);
router.use("/qr", qrRoutes);
router.use("/ledger", ledgerRoutes);
router.use("/reports", reportRoutes);
router.use("/payouts", payoutRoutes);
router.use("/requests", requestRoutes);
router.use("/tasks", taskRoutes);

// Development-only tools (DEC-050). Never available in production.
if (!isProd) router.use("/dev", devRoutes);

export default router;

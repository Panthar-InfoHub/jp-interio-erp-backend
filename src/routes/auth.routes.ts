import { Router } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { validate } from "../middlewares/validate.js";
import * as authController from "../controllers/auth.controller.js";
import { refreshSchemas, requestOtpSchemas, verifyOtpSchemas } from "../validators/auth.schema.js";
import { idParams } from "../validators/common.js";

const router = Router();

// Logging in (no access token needed)
router.post("/otp/request", validate(requestOtpSchemas), authController.requestOtp);
router.post("/otp/verify", validate(verifyOtpSchemas), authController.verifyOtp);
router.post("/refresh", validate(refreshSchemas), authController.refresh);

// My account (logged in)
router.get("/me", requireAuth, authController.me);
router.get("/sessions", requireAuth, authController.listSessions);
router.delete(
  "/sessions/:id",
  requireAuth,
  validate({ params: idParams }),
  authController.revokeSession
);
router.post("/logout", requireAuth, authController.logout);
router.post("/logout-all", requireAuth, authController.logoutAll);

export default router;

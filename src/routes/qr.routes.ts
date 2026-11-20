import { Router } from "express";
import * as qrBatchController from "../controllers/qrBatch.controller.js";
import { requireAuth } from "../middlewares/auth.js";
import { requirePermission } from "../middlewares/permission.js";
import { validate } from "../middlewares/validate.js";
import {
  createQrBatchSchemas,
  listQrProductsSchemas,
  listBatchCodesSchemas,
  listQrBatchesSchemas,
  lookupQrCodeSchemas,
  qrBatchIdSchemas,
  voidQrBatchSchemas,
} from "../validators/qrBatch.schema.js";

/**
 * QR Code Engine (Module 7), web console only. The `qr.*` permissions belong to the
 * Admin and the QR Batches Sub-Admin (DEC-018, DEC-019); everyone else gets 403.
 */
const router = Router();

router.use(requireAuth);

// Product picker for the batch screen: whoever can make a batch (DEC-122).
router.get(
  "/products",
  requirePermission("qr.generate"),
  validate(listQrProductsSchemas),
  qrBatchController.listProducts
);

router.post(
  "/batches",
  requirePermission("qr.generate"),
  validate(createQrBatchSchemas),
  qrBatchController.create
);
// ZIP for printing; any number of times, every download logged (DEC-118, DEC-123).
router.get(
  "/batches/:id/export",
  requirePermission("qr.export"),
  validate(qrBatchIdSchemas),
  qrBatchController.exportBatch
);
// Permanent; unused codes stop working, scanned ones keep their points (DEC-124).
router.post(
  "/batches/:id/void",
  requirePermission("qr.void"),
  validate(voidQrBatchSchemas),
  qrBatchController.voidBatch
);

// Lists and lookup, view only (DEC-125). The Zonal Head has no `qr.view` (DEC-044 Q7).
router.get(
  "/batches",
  requirePermission("qr.view"),
  validate(listQrBatchesSchemas),
  qrBatchController.list
);
router.get(
  "/batches/:id",
  requirePermission("qr.view"),
  validate(qrBatchIdSchemas),
  qrBatchController.get
);
router.get(
  "/batches/:id/codes",
  requirePermission("qr.view"),
  validate(listBatchCodesSchemas),
  qrBatchController.listCodes
);
router.get(
  "/codes/:code",
  requirePermission("qr.view"),
  validate(lookupQrCodeSchemas),
  qrBatchController.lookupCode
);

export default router;

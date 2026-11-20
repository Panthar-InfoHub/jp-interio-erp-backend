import { getAuthUser } from "../middlewares/auth.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import * as productService from "../services/product.service.js";
import * as qrBatchService from "../services/qrBatch.service.js";
import * as qrExportService from "../services/qrExport.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import type {
  createQrBatchSchemas,
  listQrProductsSchemas,
  listBatchCodesSchemas,
  listQrBatchesSchemas,
  lookupQrCodeSchemas,
  qrBatchIdSchemas,
  voidQrBatchSchemas,
} from "../validators/qrBatch.schema.js";

/** GET /api/qr/batches — Admin, QR Batches Sub-Admin (DEC-125). */
export const list = asyncHandler<ValidatedRequest<typeof listQrBatchesSchemas>>(
  async (req, res) => {
    const { items, meta } = await qrBatchService.listBatches(req.query);
    sendSuccess(res, 200, items, undefined, meta);
  }
);

/** GET /api/qr/batches/:id */
export const get = asyncHandler<ValidatedRequest<typeof qrBatchIdSchemas>>(async (req, res) => {
  sendSuccess(res, 200, await qrBatchService.getBatch(req.params.id));
});

/** GET /api/qr/batches/:id/codes */
export const listCodes = asyncHandler<ValidatedRequest<typeof listBatchCodesSchemas>>(
  async (req, res) => {
    const { items, meta } = await qrBatchService.listBatchCodes(req.params.id, req.query);
    sendSuccess(res, 200, items, undefined, meta);
  }
);

/** GET /api/qr/codes/:code — plain code or full (URL-encoded) link. */
export const lookupCode = asyncHandler<ValidatedRequest<typeof lookupQrCodeSchemas>>(
  async (req, res) => {
    sendSuccess(res, 200, await qrBatchService.lookupCode(req.params.code));
  }
);

/** POST /api/qr/batches/:id/void — permanent (DEC-124). */
export const voidBatch = asyncHandler<ValidatedRequest<typeof voidQrBatchSchemas>>(
  async (req, res) => {
    const result = await qrBatchService.voidBatch(getAuthUser(req), req.params.id, req.body);
    const message = result.changed
      ? `Batch voided: ${result.codesVoided} codes voided, ${result.alreadyScanned} already scanned (points kept)`
      : "Batch is already voided";
    sendSuccess(res, 200, result, message);
  }
);

/**
 * GET /api/qr/batches/:id/export — ZIP for printing (DEC-123).
 * Checks and logs first (normal JSON error if refused), then streams the file. If something
 * breaks after the file has started, Express just closes the connection.
 */
export const exportBatch = asyncHandler<ValidatedRequest<typeof qrBatchIdSchemas>>(
  async (req, res) => {
    const info = await qrExportService.startExport(getAuthUser(req), req.params.id);
    res.status(200);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${info.batchNo}.zip"`);
    res.setHeader("Cache-Control", "no-store");
    await qrExportService.streamExportZip(info, res);
  }
);

/** GET /api/qr/products — product picker for the batch screen (DEC-122). */
export const listProducts = asyncHandler<ValidatedRequest<typeof listQrProductsSchemas>>(
  async (req, res) => {
    const { items, meta } = await productService.listProductsForQrBatch(req.query);
    sendSuccess(res, 200, items, undefined, meta);
  }
);

/** POST /api/qr/batches — Admin, QR Batches Sub-Admin. */
export const create = asyncHandler<ValidatedRequest<typeof createQrBatchSchemas>>(
  async (req, res) => {
    sendSuccess(
      res,
      201,
      await qrBatchService.createBatch(getAuthUser(req), req.body),
      "QR batch created"
    );
  }
);

import { getAuthUser } from "../middlewares/auth.js";
import { getScope } from "../middlewares/permission.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import * as kycService from "../services/kyc.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import type {
  approveKycSchemas,
  kycPartnerSchemas,
  kycQueueSchemas,
  rejectKycSchemas,
  undoRejectionSchemas,
} from "../validators/kyc.schema.js";

/** KYC queue (Module 5 T8). */

/** GET /api/kyc/queue */
export const queue = asyncHandler<ValidatedRequest<typeof kycQueueSchemas>>(async (req, res) => {
  const { items, meta } = await kycService.listQueue(getAuthUser(req), getScope(req), req.query);
  sendSuccess(res, 200, items, undefined, meta);
});

/** GET /api/kyc/:id */
export const get = asyncHandler<ValidatedRequest<typeof kycPartnerSchemas>>(async (req, res) => {
  sendSuccess(
    res,
    200,
    await kycService.getForReview(getAuthUser(req), getScope(req), req.params.id)
  );
});

/** POST /api/kyc/:id/approve */
export const approve = asyncHandler<ValidatedRequest<typeof approveKycSchemas>>(
  async (req, res) => {
    const data = await kycService.approve(
      getAuthUser(req),
      getScope(req),
      req.params.id,
      req.body.asmId
    );
    sendSuccess(res, 200, data, "Partner approved");
  }
);

/** POST /api/kyc/:id/reject */
export const reject = asyncHandler<ValidatedRequest<typeof rejectKycSchemas>>(async (req, res) => {
  const data = await kycService.reject(
    getAuthUser(req),
    getScope(req),
    req.params.id,
    req.body.reason
  );
  sendSuccess(res, 200, data, "Partner rejected");
});

/** POST /api/kyc/:id/undo-rejection — Admin only. */
export const undoRejection = asyncHandler<ValidatedRequest<typeof undoRejectionSchemas>>(
  async (req, res) => {
    const data = await kycService.undoRejection(
      getAuthUser(req),
      getScope(req),
      req.params.id,
      req.body.reason
    );
    sendSuccess(res, 200, data, "Rejection undone. The partner is back in the queue.");
  }
);

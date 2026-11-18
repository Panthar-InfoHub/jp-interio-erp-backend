import { getAuthUser } from "../middlewares/auth.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import * as onboardingService from "../services/onboarding.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import type {
  basicInfoSchemas,
  firmDetailsSchemas,
  kycSchemas,
  payoutAccountSchemas,
} from "../validators/onboarding.schema.js";

/** Partner self sign-up (Module 5 T4). The partner always works on their own record. */

/** GET /api/partner/onboarding/zones — zones to pick on the basic info page. */
export const listZones = asyncHandler(async (_req, res) => {
  sendSuccess(res, 200, await onboardingService.listZonesForSignUp());
});

/** GET /api/partner/onboarding — "where am I?" */
export const get = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, await onboardingService.getOnboarding(getAuthUser(req).id));
});

/** PUT /api/partner/onboarding/basic-info */
export const saveBasicInfo = asyncHandler<ValidatedRequest<typeof basicInfoSchemas>>(
  async (req, res) => {
    const user = getAuthUser(req);
    const data = await onboardingService.saveBasicInfo(user, user.id, req.body);
    sendSuccess(res, 200, data, "Basic info saved");
  }
);

/** PUT /api/partner/onboarding/firm-details */
export const saveFirmDetails = asyncHandler<ValidatedRequest<typeof firmDetailsSchemas>>(
  async (req, res) => {
    const user = getAuthUser(req);
    const data = await onboardingService.saveFirmDetails(user, user.id, req.body);
    sendSuccess(res, 200, data, "Firm details saved");
  }
);

/** POST /api/partner/onboarding/payout-account */
export const savePayoutAccount = asyncHandler<ValidatedRequest<typeof payoutAccountSchemas>>(
  async (req, res) => {
    const user = getAuthUser(req);
    const data = await onboardingService.savePayoutAccount(user, user.id, req.body);
    sendSuccess(res, 201, data, "Payout account saved");
  }
);

/** PUT /api/partner/onboarding/kyc */
export const saveKyc = asyncHandler<ValidatedRequest<typeof kycSchemas>>(async (req, res) => {
  const user = getAuthUser(req);
  const data = await onboardingService.saveKyc(user, user.id, req.body);
  sendSuccess(res, 200, data, "KYC documents saved");
});

/** POST /api/partner/onboarding/submit */
export const submit = asyncHandler(async (req, res) => {
  const user = getAuthUser(req);
  const data = await onboardingService.submitOnboarding(user, user.id);
  sendSuccess(res, 200, data, "Submitted for approval");
});

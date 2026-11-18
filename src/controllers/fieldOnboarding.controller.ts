import { getAuthUser } from "../middlewares/auth.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import * as fieldOnboardingService from "../services/fieldOnboarding.service.js";
import * as onboardingService from "../services/onboarding.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import type {
  fieldBasicInfoSchemas,
  fieldFirmDetailsSchemas,
  fieldKycSchemas,
  fieldPartnerSchemas,
  fieldPayoutAccountSchemas,
  fieldStartSchemas,
  fieldVerifySchemas,
} from "../validators/onboarding.schema.js";

/** Field onboarding by an ASM / Sales Executive (Module 5 T5). */

/** POST /api/field/onboarding/start — OTP to the new partner's phone. */
export const start = asyncHandler<ValidatedRequest<typeof fieldStartSchemas>>(async (req, res) => {
  const data = await fieldOnboardingService.startFieldOnboarding(
    getAuthUser(req),
    req.body.phone,
    req.ip
  );
  sendSuccess(res, 200, data, "OTP sent to the partner's phone");
});

/** POST /api/field/onboarding/verify — creates the partner's account. */
export const verify = asyncHandler<ValidatedRequest<typeof fieldVerifySchemas>>(
  async (req, res) => {
    const data = await fieldOnboardingService.verifyFieldOnboarding(
      getAuthUser(req),
      req.body.phone,
      req.body.otp
    );
    sendSuccess(res, 201, data, "Partner account created");
  }
);

/** GET /api/field/onboarding/drafts — my unfinished onboardings. */
export const listDrafts = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, await fieldOnboardingService.listMyDrafts(getAuthUser(req)));
});

/** GET /api/field/onboarding/:partnerId */
export const get = asyncHandler<ValidatedRequest<typeof fieldPartnerSchemas>>(async (req, res) => {
  sendSuccess(
    res,
    200,
    await fieldOnboardingService.getMyOnboarding(getAuthUser(req), req.params.partnerId)
  );
});

/** PUT /api/field/onboarding/:partnerId/basic-info */
export const saveBasicInfo = asyncHandler<ValidatedRequest<typeof fieldBasicInfoSchemas>>(
  async (req, res) => {
    const data = await onboardingService.saveBasicInfo(
      getAuthUser(req),
      req.params.partnerId,
      req.body
    );
    sendSuccess(res, 200, data, "Basic info saved");
  }
);

/** PUT /api/field/onboarding/:partnerId/firm-details */
export const saveFirmDetails = asyncHandler<ValidatedRequest<typeof fieldFirmDetailsSchemas>>(
  async (req, res) => {
    const data = await onboardingService.saveFirmDetails(
      getAuthUser(req),
      req.params.partnerId,
      req.body
    );
    sendSuccess(res, 200, data, "Firm details saved");
  }
);

/** POST /api/field/onboarding/:partnerId/payout-account */
export const savePayoutAccount = asyncHandler<ValidatedRequest<typeof fieldPayoutAccountSchemas>>(
  async (req, res) => {
    const data = await onboardingService.savePayoutAccount(
      getAuthUser(req),
      req.params.partnerId,
      req.body
    );
    sendSuccess(res, 201, data, "Payout account saved");
  }
);

/** PUT /api/field/onboarding/:partnerId/kyc */
export const saveKyc = asyncHandler<ValidatedRequest<typeof fieldKycSchemas>>(async (req, res) => {
  const data = await onboardingService.saveKyc(getAuthUser(req), req.params.partnerId, req.body);
  sendSuccess(res, 200, data, "KYC documents saved");
});

/** POST /api/field/onboarding/:partnerId/submit */
export const submit = asyncHandler<ValidatedRequest<typeof fieldPartnerSchemas>>(
  async (req, res) => {
    const data = await onboardingService.submitOnboarding(getAuthUser(req), req.params.partnerId);
    sendSuccess(res, 200, data, "Submitted for approval");
  }
);

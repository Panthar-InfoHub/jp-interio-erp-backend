import type { Request } from "express";
import { getAuthUser } from "../middlewares/auth.js";
import { getScope } from "../middlewares/permission.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import * as payoutAccountService from "../services/payoutAccount.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import type {
  addMyAccountSchemas,
  addPartnerAccountSchemas,
  editMyAccountSchemas,
  editPartnerAccountSchemas,
  myAccountSchemas,
  partnerAccountSchemas,
  partnerAccountsSchemas,
} from "../validators/payoutAccount.schema.js";

/**
 * Payout accounts (Module 5 T10). The same service serves both:
 * - Partner App: `/api/partner/payout-accounts/...` (the partner is the logged-in user);
 * - staff: `/api/partners/:id/payout-accounts/...`.
 * Every reply is the partner's active accounts after the change.
 */

const me = (req: Request) => getAuthUser(req).id;

// ---- Partner App ----

export const listMine = asyncHandler(async (req, res) => {
  sendSuccess(
    res,
    200,
    await payoutAccountService.getAccounts(getAuthUser(req), getScope(req), me(req))
  );
});

export const addMine = asyncHandler<ValidatedRequest<typeof addMyAccountSchemas>>(
  async (req, res) => {
    const data = await payoutAccountService.addAccount(
      getAuthUser(req),
      getScope(req),
      me(req),
      req.body
    );
    sendSuccess(res, 201, data, "Payout account added");
  }
);

export const editMine = asyncHandler<ValidatedRequest<typeof editMyAccountSchemas>>(
  async (req, res) => {
    const data = await payoutAccountService.editAccount(
      getAuthUser(req),
      getScope(req),
      me(req),
      req.params.accountId,
      req.body
    );
    sendSuccess(res, 200, data, "Payout account updated");
  }
);

export const setDefaultMine = asyncHandler<ValidatedRequest<typeof myAccountSchemas>>(
  async (req, res) => {
    const data = await payoutAccountService.setDefaultAccount(
      getAuthUser(req),
      getScope(req),
      me(req),
      req.params.accountId
    );
    sendSuccess(res, 200, data, "Default account set");
  }
);

export const removeMine = asyncHandler<ValidatedRequest<typeof myAccountSchemas>>(
  async (req, res) => {
    const data = await payoutAccountService.removeAccount(
      getAuthUser(req),
      getScope(req),
      me(req),
      req.params.accountId
    );
    sendSuccess(res, 200, data, "Payout account removed");
  }
);

// ---- Staff ----

export const listForPartner = asyncHandler<ValidatedRequest<typeof partnerAccountsSchemas>>(
  async (req, res) => {
    sendSuccess(
      res,
      200,
      await payoutAccountService.getAccounts(getAuthUser(req), getScope(req), req.params.id)
    );
  }
);

export const addForPartner = asyncHandler<ValidatedRequest<typeof addPartnerAccountSchemas>>(
  async (req, res) => {
    const data = await payoutAccountService.addAccount(
      getAuthUser(req),
      getScope(req),
      req.params.id,
      req.body
    );
    sendSuccess(res, 201, data, "Payout account added");
  }
);

export const editForPartner = asyncHandler<ValidatedRequest<typeof editPartnerAccountSchemas>>(
  async (req, res) => {
    const data = await payoutAccountService.editAccount(
      getAuthUser(req),
      getScope(req),
      req.params.id,
      req.params.accountId,
      req.body
    );
    sendSuccess(res, 200, data, "Payout account updated");
  }
);

export const setDefaultForPartner = asyncHandler<ValidatedRequest<typeof partnerAccountSchemas>>(
  async (req, res) => {
    const data = await payoutAccountService.setDefaultAccount(
      getAuthUser(req),
      getScope(req),
      req.params.id,
      req.params.accountId
    );
    sendSuccess(res, 200, data, "Default account set");
  }
);

export const removeForPartner = asyncHandler<ValidatedRequest<typeof partnerAccountSchemas>>(
  async (req, res) => {
    const data = await payoutAccountService.removeAccount(
      getAuthUser(req),
      getScope(req),
      req.params.id,
      req.params.accountId
    );
    sendSuccess(res, 200, data, "Payout account removed");
  }
);

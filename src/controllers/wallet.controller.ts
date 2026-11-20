import { getAuthUser } from "../middlewares/auth.js";
import { getScope } from "../middlewares/permission.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import * as pointsAdjustmentService from "../services/pointsAdjustment.service.js";
import * as walletService from "../services/wallet.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import type {
  ledgerSchemas,
  myStatementSchemas,
  partnerLedgerSchemas,
  partnerWalletSchemas,
} from "../validators/wallet.schema.js";
import type { pointsAdjustmentSchemas } from "../validators/pointsAdjustment.schema.js";

// ---- The partner's own wallet, Partner App (Module 8 T4, DEC-133) ----

/** GET /api/partner/wallet — balances, with rupees from the server. */
export const myWallet = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, await walletService.getWallet(getAuthUser(req).id));
});

/** GET /api/partner/wallet/statement — my passbook, newest first, paged. */
export const myStatement = asyncHandler<ValidatedRequest<typeof myStatementSchemas>>(
  async (req, res) => {
    const { items, meta } = await walletService.getMyStatement(getAuthUser(req).id, req.query);
    sendSuccess(res, 200, items, undefined, meta);
  }
);

// ---- Staff views, `ledger.view` within scope (Module 8 T5, DEC-134) ----

/** GET /api/partners/:id/wallet — one partner's balances (or `wallet: null` + note). */
export const partnerWallet = asyncHandler<ValidatedRequest<typeof partnerWalletSchemas>>(
  async (req, res) => {
    sendSuccess(
      res,
      200,
      await walletService.getPartnerWallet(getAuthUser(req), getScope(req), req.params.id)
    );
  }
);

/** GET /api/partners/:id/ledger — one partner's passbook. */
export const partnerLedger = asyncHandler<ValidatedRequest<typeof partnerLedgerSchemas>>(
  async (req, res) => {
    const { items, meta } = await walletService.getPartnerLedger(
      getAuthUser(req),
      getScope(req),
      req.params.id,
      req.query
    );
    sendSuccess(res, 200, items, undefined, meta);
  }
);

/** POST /api/partners/:id/points-adjustment — Admin / Rewards Sub-Admin (Module 8 T6). */
export const adjustPoints = asyncHandler<ValidatedRequest<typeof pointsAdjustmentSchemas>>(
  async (req, res) => {
    const data = await pointsAdjustmentService.adjustPoints(
      getAuthUser(req),
      getScope(req),
      req.params.id,
      req.body
    );
    const message = req.body.direction === "credit" ? "Points added" : "Points taken away";
    sendSuccess(res, 201, data, message);
  }
);

/** GET /api/ledger — lines across partners in scope, with totals for the whole filter. */
export const ledger = asyncHandler<ValidatedRequest<typeof ledgerSchemas>>(async (req, res) => {
  const { items, meta, totals } = await walletService.listLedger(
    getAuthUser(req),
    getScope(req),
    req.query
  );
  sendSuccess(res, 200, items, undefined, { ...meta, totals });
});

import { getAuthUser } from "../middlewares/auth.js";
import { getScope } from "../middlewares/permission.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import * as userService from "../services/user.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import type {
  createUserSchemas,
  listUsersSchemas,
  pickerSchemas,
  transferUserSchemas,
  updateMeSchemas,
  updateUserSchemas,
  userIdSchemas,
} from "../validators/user.schema.js";

/** POST /api/users — add a staff member (Admin, Zonal Head, ASM; DEC-062). */
export const create = asyncHandler<ValidatedRequest<typeof createUserSchemas>>(async (req, res) => {
  sendSuccess(res, 201, await userService.createUser(getAuthUser(req), req.body), "Staff added");
});

/** GET /api/users — the staff list, scoped (DEC-063). */
export const list = asyncHandler<ValidatedRequest<typeof listUsersSchemas>>(async (req, res) => {
  const { items, meta } = await userService.listUsers(getAuthUser(req), getScope(req), req.query);
  sendSuccess(res, 200, items, undefined, meta);
});

/** GET /api/users/picker — active field staff for "assign to" dropdowns (DEC-063). */
export const picker = asyncHandler<ValidatedRequest<typeof pickerSchemas>>(async (req, res) => {
  const { items, meta } = await userService.pickStaff(req.query);
  sendSuccess(res, 200, items, undefined, meta);
});

/** PATCH /api/users/:id — Admin / Zonal Head edits name, phone, email (DEC-064). */
export const update = asyncHandler<ValidatedRequest<typeof updateUserSchemas>>(async (req, res) => {
  const { user, changed, sessionsEnded } = await userService.updateUser(
    getAuthUser(req),
    getScope(req),
    req.params.id,
    req.body
  );
  const message = !changed
    ? "No change"
    : sessionsEnded > 0
      ? "Staff updated. They were logged out because their phone changed."
      : "Staff updated";
  sendSuccess(res, 200, user, message);
});

/** PATCH /api/users/me — my own name and email (DEC-064). */
export const updateMe = asyncHandler<ValidatedRequest<typeof updateMeSchemas>>(async (req, res) => {
  const { user, changed } = await userService.updateMe(getAuthUser(req), req.body);
  sendSuccess(res, 200, user, changed ? "Profile updated" : "No change");
});

/** POST /api/users/:id/deactivate — switch a staff member off (DEC-065). */
export const deactivate = asyncHandler<ValidatedRequest<typeof userIdSchemas>>(async (req, res) => {
  const { user, changed, partnersReturned } = await userService.deactivateUser(
    getAuthUser(req),
    req.params.id
  );
  const message = !changed
    ? "Already deactivated"
    : partnersReturned > 0
      ? `Staff deactivated. ${partnersReturned} partner(s) went back to their ASM.`
      : "Staff deactivated";
  sendSuccess(res, 200, user, message);
});

/** POST /api/users/:id/reactivate — switch a staff member back on (DEC-065). */
export const reactivate = asyncHandler<ValidatedRequest<typeof userIdSchemas>>(async (req, res) => {
  const { user, changed } = await userService.reactivateUser(getAuthUser(req), req.params.id);
  sendSuccess(res, 200, user, changed ? "Staff reactivated" : "Already active");
});

/** POST /api/users/:id/transfer — move a Sales Executive or an ASM (DEC-066). */
export const transfer = asyncHandler<ValidatedRequest<typeof transferUserSchemas>>(
  async (req, res) => {
    const { user, partnersUnassigned } = await userService.transferUser(
      getAuthUser(req),
      req.params.id,
      req.body
    );
    const message =
      partnersUnassigned > 0
        ? `Staff moved. ${partnersUnassigned} partner(s) stayed with the old ASM, unassigned.`
        : "Staff moved";
    sendSuccess(res, 200, user, message);
  }
);

/** GET /api/users/:id — one staff member, scoped (DEC-063). */
export const get = asyncHandler<ValidatedRequest<typeof userIdSchemas>>(async (req, res) => {
  sendSuccess(res, 200, await userService.getUser(getAuthUser(req), getScope(req), req.params.id));
});

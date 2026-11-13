import { getAuthUser } from "../middlewares/auth.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import * as zoneService from "../services/zone.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import type {
  createZoneSchemas,
  listZonesSchemas,
  setZonalHeadSchemas,
  updateZoneSchemas,
  zoneIdSchemas,
} from "../validators/zone.schema.js";

/** GET /api/zones — any staff user. */
export const list = asyncHandler<ValidatedRequest<typeof listZonesSchemas>>(async (req, res) => {
  const { items, meta } = await zoneService.listZones(req.query);
  sendSuccess(res, 200, items, undefined, meta);
});

/** GET /api/zones/:id — any staff user. */
export const get = asyncHandler<ValidatedRequest<typeof zoneIdSchemas>>(async (req, res) => {
  sendSuccess(res, 200, await zoneService.getZone(req.params.id));
});

/** POST /api/zones — Admin. */
export const create = asyncHandler<ValidatedRequest<typeof createZoneSchemas>>(async (req, res) => {
  sendSuccess(res, 201, await zoneService.createZone(getAuthUser(req), req.body), "Zone created");
});

/** PATCH /api/zones/:id — Admin. */
export const update = asyncHandler<ValidatedRequest<typeof updateZoneSchemas>>(async (req, res) => {
  const { zone, changed } = await zoneService.updateZone(getAuthUser(req), req.params.id, req.body);
  sendSuccess(res, 200, zone, changed ? "Zone updated" : "No change");
});

/** POST /api/zones/:id/deactivate — Admin. */
export const deactivate = asyncHandler<ValidatedRequest<typeof zoneIdSchemas>>(async (req, res) => {
  const { zone, changed } = await zoneService.deactivateZone(getAuthUser(req), req.params.id);
  sendSuccess(res, 200, zone, changed ? "Zone deactivated" : "Zone is already inactive");
});

/** POST /api/zones/:id/zonal-head — Admin puts a Zonal Head in charge (DEC-067). */
export const setZonalHead = asyncHandler<ValidatedRequest<typeof setZonalHeadSchemas>>(
  async (req, res) => {
    const { zone, replaced, asmsMoved } = await zoneService.setZonalHead(
      getAuthUser(req),
      req.params.id,
      req.body.userId
    );
    const message =
      (replaced ? "Zonal Head replaced" : "Zonal Head appointed") +
      (asmsMoved > 0 ? `. ${asmsMoved} ASM(s) now report to them.` : "");
    sendSuccess(res, 200, zone, message);
  }
);

/** POST /api/zones/:id/reactivate — Admin. */
export const reactivate = asyncHandler<ValidatedRequest<typeof zoneIdSchemas>>(async (req, res) => {
  const { zone, changed } = await zoneService.reactivateZone(getAuthUser(req), req.params.id);
  sendSuccess(res, 200, zone, changed ? "Zone reactivated" : "Zone is already active");
});

import { ROLE } from "../config/roles.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { ZoneStatus } from "../generated/prisma/enums.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";
import { pageMeta, toPrismaOrderBy, toPrismaPaging } from "../utils/pagination.js";
import type {
  CreateZoneInput,
  ListZonesQuery,
  UpdateZoneInput,
} from "../validators/zone.schema.js";
import { revokeAllSessions } from "./session.service.js";
import { recordAudit } from "./audit.service.js";

/**
 * Zones (Module 4, Task 1; DEC-060).
 * - Every staff user can view zones; only the Admin changes them (`zones.manage`).
 * - Never deleted, only switched off.
 * - The code is saved in CAPITALS, is unique, and is locked once anyone is in the zone.
 * - The name is unique too, ignoring capitals (DEC-061).
 * - A zone cannot be switched off while anyone (staff or partner) who is not
 *   deactivated is still in it.
 * The Zonal Head is not set here: that is Tasks 2 and 7. Here it is only shown.
 */

const ZONE_FIELDS = {
  id: true,
  name: true,
  code: true,
  region: true,
  state: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ZoneSelect;

/** People still "in" a zone: anyone not deactivated (active or suspended). */
const NOT_DEACTIVATED = { status: { not: "deactivated" } } satisfies Prisma.UserWhereInput;

type ZoneRow = Prisma.ZoneGetPayload<{ select: typeof ZONE_FIELDS }>;

/**
 * Adds the Zonal Head and headcounts to each zone, with two queries in total
 * (not two per zone). Deactivated people are not counted.
 */
async function withPeople(zones: ZoneRow[]) {
  const zoneIds = zones.map((zone) => zone.id);
  if (zoneIds.length === 0) return [];

  const [zonalHeads, counts] = await Promise.all([
    prisma.user.findMany({
      where: { zoneId: { in: zoneIds }, roleId: ROLE.ZONAL_HEAD, ...NOT_DEACTIVATED },
      select: { id: true, name: true, phone: true, status: true, zoneId: true },
    }),
    prisma.user.groupBy({
      by: ["zoneId", "roleId"],
      where: { zoneId: { in: zoneIds }, ...NOT_DEACTIVATED },
      _count: { _all: true },
    }),
  ]);

  return zones.map((zone) => {
    const zoneCounts = counts.filter((row) => row.zoneId === zone.id);
    const countOf = (roleId: number) =>
      zoneCounts.find((row) => row.roleId === roleId)?._count._all ?? 0;
    const zonalHead = zonalHeads.find((user) => user.zoneId === zone.id) ?? null;

    return {
      ...zone,
      zonalHead: zonalHead && {
        id: zonalHead.id,
        name: zonalHead.name,
        phone: zonalHead.phone,
        status: zonalHead.status,
      },
      counts: {
        asms: countOf(ROLE.ASM),
        salesExecutives: countOf(ROLE.SALES_EXECUTIVE),
        partners: countOf(ROLE.PARTNER),
      },
    };
  });
}

/** The zone with this id, or 404. */
async function findZone(id: string): Promise<ZoneRow> {
  const zone = await prisma.zone.findUnique({ where: { id }, select: ZONE_FIELDS });
  if (!zone) throw new NotFoundError("Zone not found");
  return zone;
}

/** A clear 409 before the database's own unique check (which stays as the safety net). */
async function assertCodeFree(code: string, exceptZoneId?: string) {
  const taken = await prisma.zone.findFirst({
    where: { code, ...(exceptZoneId && { id: { not: exceptZoneId } }) },
    select: { id: true },
  });
  if (taken) throw new ConflictError(`A zone with code ${code} already exists`);
}

/**
 * Zone names are unique too, ignoring capitals: "North Zone" and "north zone" clash
 * (DEC-061). Checked in code only; the database has no unique rule on the name.
 */
async function assertNameFree(name: string, exceptZoneId?: string) {
  const taken = await prisma.zone.findFirst({
    where: {
      name: { equals: name, mode: "insensitive" },
      ...(exceptZoneId && { id: { not: exceptZoneId } }),
    },
    select: { name: true },
  });
  if (taken) throw new ConflictError(`A zone named "${taken.name}" already exists`);
}

/** GET /zones — paginated, with search and status filter. */
export async function listZones(query: ListZonesQuery) {
  const where: Prisma.ZoneWhereInput = {
    ...(query.status && { status: query.status }),
    ...(query.search && {
      OR: (["name", "code", "region", "state"] as const).map((field) => ({
        [field]: { contains: query.search, mode: "insensitive" },
      })),
    }),
  };

  const [zones, total] = await Promise.all([
    prisma.zone.findMany({
      where,
      select: ZONE_FIELDS,
      orderBy: toPrismaOrderBy(query.sort),
      ...toPrismaPaging(query.page, query.limit),
    }),
    prisma.zone.count({ where }),
  ]);

  return { items: await withPeople(zones), meta: pageMeta(query.page, query.limit, total) };
}

/** GET /zones/:id */
export async function getZone(id: string) {
  const [zone] = await withPeople([await findZone(id)]);
  return zone!;
}

/** POST /zones (Admin). */
export async function createZone(admin: AuthUser, input: CreateZoneInput) {
  await assertCodeFree(input.code);
  await assertNameFree(input.name);

  const zone = await prisma.$transaction(async (tx) => {
    const created = await tx.zone.create({
      data: {
        name: input.name,
        code: input.code,
        region: input.region ?? null,
        state: input.state ?? null,
      },
      select: ZONE_FIELDS,
    });
    await recordAudit(tx, {
      actorId: admin.id,
      action: "zone.create",
      entity: { type: "zone", id: created.id },
      after: {
        name: created.name,
        code: created.code,
        region: created.region,
        state: created.state,
      },
    });
    return created;
  });

  return getZone(zone.id);
}

/**
 * PATCH /zones/:id (Admin). Only the fields that really change are saved and audited.
 * The code is locked once anyone (even a deactivated person) has been in the zone,
 * because old records point to it.
 */
export async function updateZone(admin: AuthUser, id: string, input: UpdateZoneInput) {
  const zone = await findZone(id);

  const changes: Partial<Pick<ZoneRow, "name" | "code" | "region" | "state">> = {};
  for (const field of ["name", "code", "region", "state"] as const) {
    const value = input[field];
    if (value !== undefined && value !== zone[field]) {
      (changes as Record<string, unknown>)[field] = value;
    }
  }
  if (Object.keys(changes).length === 0) return { zone: await getZone(id), changed: false };

  if (changes.name !== undefined) await assertNameFree(changes.name, id);
  if (changes.code !== undefined) {
    const used = await prisma.user.count({ where: { zoneId: id } });
    if (used > 0) {
      throw new ConflictError("The zone code cannot change once people have been added to it");
    }
    await assertCodeFree(changes.code, id);
  }

  await prisma.$transaction(async (tx) => {
    await tx.zone.update({ where: { id }, data: changes });
    await recordAudit(tx, {
      actorId: admin.id,
      action: "zone.update",
      entity: { type: "zone", id },
      before: Object.fromEntries(
        Object.keys(changes).map((key) => [key, zone[key as keyof ZoneRow]])
      ),
      after: changes,
    });
  });

  return { zone: await getZone(id), changed: true };
}

/** Shared by deactivate and reactivate. The same status again changes nothing. */
async function setStatus(admin: AuthUser, id: string, status: ZoneStatus) {
  const zone = await findZone(id);
  if (zone.status === status) return { zone: await getZone(id), changed: false };

  if (status === "inactive") {
    const people = await prisma.user.count({ where: { zoneId: id, ...NOT_DEACTIVATED } });
    if (people > 0) {
      throw new ConflictError(
        `This zone still has ${people} ${people === 1 ? "person" : "people"} in it. Move them to another zone first.`
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.zone.update({ where: { id }, data: { status } });
    await recordAudit(tx, {
      actorId: admin.id,
      action: status === "inactive" ? "zone.deactivate" : "zone.reactivate",
      entity: { type: "zone", id },
      before: { status: zone.status },
      after: { status },
    });
  });

  return { zone: await getZone(id), changed: true };
}

/** POST /zones/:id/deactivate (Admin). */
export const deactivateZone = (admin: AuthUser, id: string) => setStatus(admin, id, "inactive");

/** POST /zones/:id/reactivate (Admin). */
export const reactivateZone = (admin: AuthUser, id: string) => setStatus(admin, id, "active");

/**
 * POST /zones/:id/zonal-head (Admin; Module 4 Task 7, DEC-067).
 * Puts an active Zonal Head who has no zone in charge of this zone. In one transaction:
 * - the new Zonal Head gets the zone;
 * - every ASM in the zone (any status) now reports to them;
 * - the old Zonal Head (if any) loses the zone and stays active with no zone;
 * - both are logged out; one audit row.
 * Also fills an empty zone, and is how a Zonal Head moves to another zone.
 */
export async function setZonalHead(admin: AuthUser, zoneId: string, userId: string) {
  const result = await prisma.$transaction(async (tx) => {
    // Lock the zone so two replacements (or an ASM being added) can't run at once.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM zones WHERE id = ${zoneId}::uuid FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundError("Zone not found");
    const zone = await tx.zone.findUniqueOrThrow({
      where: { id: zoneId },
      select: { name: true, status: true },
    });
    if (zone.status !== "active") {
      throw new ConflictError(`Zone "${zone.name}" is inactive. Reactivate the zone first.`);
    }

    const newHead = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, roleId: true, status: true, zoneId: true },
    });
    if (!newHead || newHead.roleId !== ROLE.ZONAL_HEAD) {
      throw new NotFoundError("Zonal Head not found");
    }
    if (newHead.status !== "active") {
      throw new ConflictError("This Zonal Head is not active. Choose an active Zonal Head.");
    }
    if (newHead.zoneId === zoneId) {
      throw new ConflictError("This Zonal Head is already in charge of this zone.");
    }
    if (newHead.zoneId !== null) {
      throw new ConflictError(
        "This Zonal Head is in charge of another zone. Replace them there first, so they have no zone."
      );
    }

    const oldHead = await tx.user.findFirst({
      where: { zoneId, roleId: ROLE.ZONAL_HEAD, ...NOT_DEACTIVATED },
      select: { id: true },
    });

    // Every Zonal Head linked to the zone loses it (normally just the old one).
    await tx.user.updateMany({
      where: { zoneId, roleId: ROLE.ZONAL_HEAD },
      data: { zoneId: null },
    });
    await tx.user.update({ where: { id: newHead.id }, data: { zoneId } });
    const { count: asmsMoved } = await tx.user.updateMany({
      where: { zoneId, roleId: ROLE.ASM },
      data: { parentId: newHead.id },
    });

    await recordAudit(tx, {
      actorId: admin.id,
      action: "zone.set_zonal_head",
      entity: { type: "zone", id: zoneId },
      before: { zonalHeadId: oldHead?.id ?? null },
      after: { zonalHeadId: newHead.id, asmsMoved },
    });

    for (const id of [newHead.id, ...(oldHead ? [oldHead.id] : [])]) {
      await revokeAllSessions(tx, { userId: id, reason: "admin_revoked", actorId: admin.id });
    }
    return { replaced: oldHead !== null, asmsMoved };
  });

  return { ...result, zone: await getZone(zoneId) };
}

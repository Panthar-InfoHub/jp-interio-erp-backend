import type { Capability } from "../config/capabilities.js";
import { ROLE, type RoleId } from "../config/roles.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { PermissionScope, SubAdminArea } from "../generated/prisma/enums.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../utils/errors.js";
import { pageMeta, toPrismaOrderBy, toPrismaPaging } from "../utils/pagination.js";
import type {
  CreateUserInput,
  ListUsersQuery,
  PickerQuery,
  TransferUserInput,
  UpdateMeInput,
  UpdateUserInput,
} from "../validators/user.schema.js";
import { recordAudit } from "./audit.service.js";
import { assertCanCreate, assertCanManage } from "./hierarchy.service.js";
import { revokeAllSessions } from "./session.service.js";
import { getPermissionScope } from "./permission.service.js";
import { assertInScope, scopeForStaff } from "./scope.service.js";

/**
 * Staff users (Module 4). Task 2: adding staff (DEC-062).
 *
 * Who adds whom:
 * - Admin → Sub-Admin, Zonal Head, ASM, Sales Executive (any zone)
 * - Zonal Head → ASM, Sales Executive (own zone)
 * - ASM → Sales Executive (under themselves)
 * - Sub-Admin, Sales Executive → nobody (DEC-058)
 *
 * Where the new person sits:
 * - Sub-Admin: under the Admin, no zone
 * - Zonal Head: under the Admin, in an active zone with no Zonal Head, or no zone yet
 * - ASM: under the zone's Zonal Head (refused if the zone has none)
 * - Sales Executive: under the chosen ASM, in the ASM's zone
 */

type RoleKey = CreateUserInput["role"];

/** Role key → role id, for every staff role (the list filter can also ask for the Admin). */
const STAFF_ROLE_ID = {
  admin: ROLE.ADMIN,
  sub_admin: ROLE.SUB_ADMIN,
  zonal_head: ROLE.ZONAL_HEAD,
  asm: ROLE.ASM,
  sales_executive: ROLE.SALES_EXECUTIVE,
} as const satisfies Record<string, RoleId>;

const ROLE_ID: Record<RoleKey, RoleId> = STAFF_ROLE_ID;

/** The action in the permission list that allows adding each role (DEC-044). */
const CREATE_ACTION: Record<RoleKey, Capability> = {
  sub_admin: "sub_admins.manage",
  zonal_head: "users.create",
  asm: "users.create",
  sales_executive: "sales_exec.create",
};

/** People who still count (active or suspended). */
const NOT_DEACTIVATED = { status: { not: "deactivated" } } satisfies Prisma.UserWhereInput;

/** What a staff member looks like in replies. */
export const STAFF_FIELDS = {
  id: true,
  name: true,
  phone: true,
  email: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  role: { select: { id: true, key: true, name: true } },
  zone: { select: { id: true, name: true, code: true, status: true } },
  parent: { select: { id: true, name: true, role: { select: { key: true, name: true } } } },
  subAdminAreas: { select: { area: true } },
} satisfies Prisma.UserSelect;

type StaffRow = Prisma.UserGetPayload<{ select: typeof STAFF_FIELDS }>;

/** Flattens Sub-Admin areas to a plain list (empty for other roles). */
function toStaff({ subAdminAreas, ...user }: StaffRow) {
  return { ...user, areas: subAdminAreas.map((grant) => grant.area) };
}

function refuse(me: AuthUser, reason: string, extra: Record<string, unknown> = {}): never {
  logger.warn({ userId: me.id, role: me.roleKey, reason, ...extra }, "Add staff refused");
  throw new ForbiddenError();
}

/** May `me` add this role at all? Returns the scope ("full" / "scoped" / "own"). */
async function scopeToCreate(me: AuthUser, role: RoleKey): Promise<PermissionScope> {
  const scope = await getPermissionScope(me, CREATE_ACTION[role]);
  if (!scope) refuse(me, "no_permission", { newRole: role, capability: CREATE_ACTION[role] });
  return scope;
}

/** The zone, which must exist and be active. */
async function findActiveZone(tx: Prisma.TransactionClient, zoneId: string) {
  // Lock the zone row until the transaction ends, so two people can't both become
  // its Zonal Head, and an ASM can't be added while its Zonal Head is being set.
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM zones WHERE id = ${zoneId}::uuid FOR UPDATE`;
  if (locked.length === 0) throw new NotFoundError("Zone not found");

  const zone = await tx.zone.findUniqueOrThrow({
    where: { id: zoneId },
    select: { id: true, name: true, status: true },
  });
  if (zone.status !== "active") {
    throw new ConflictError(`Zone "${zone.name}" is inactive. Staff cannot be added to it.`);
  }
  return zone;
}

/** The zone's Zonal Head (active or suspended), or null. */
function findZonalHead(tx: Prisma.TransactionClient, zoneId: string) {
  return tx.user.findFirst({
    where: { zoneId, roleId: ROLE.ZONAL_HEAD, ...NOT_DEACTIVATED },
    select: { id: true, name: true },
  });
}

/**
 * Phone and email must not belong to anyone else (staff or partner).
 * `exceptUserId`: the person being edited, who may keep their own.
 */
async function assertContactFree(
  tx: Prisma.TransactionClient,
  phone: string | undefined,
  email: string | null | undefined,
  exceptUserId?: string
) {
  const notMe = exceptUserId ? { id: { not: exceptUserId } } : {};
  if (phone && (await tx.user.findFirst({ where: { phone, ...notMe }, select: { id: true } }))) {
    throw new ConflictError("This phone number already belongs to another account");
  }
  if (
    email &&
    (await tx.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" }, ...notMe },
      select: { id: true },
    }))
  ) {
    throw new ConflictError("This email already belongs to another account");
  }
}

/** The Admin's id: the manager of every Sub-Admin and Zonal Head. */
async function findAdminId(me: AuthUser, tx: Prisma.TransactionClient): Promise<string> {
  if (me.roleId === ROLE.ADMIN) return me.id;
  // Only the Admin can add Sub-Admins and Zonal Heads today, but stay safe if that changes.
  const admin = await tx.user.findFirst({
    where: { roleId: ROLE.ADMIN, status: "active" },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (!admin) throw new Error("No active Admin found");
  return admin.id;
}

/**
 * Works out the new person's manager and zone, and checks every rule.
 * Runs inside the transaction so the checks and the insert see the same data.
 */
async function placeNewPerson(
  me: AuthUser,
  scope: PermissionScope,
  input: CreateUserInput,
  tx: Prisma.TransactionClient
): Promise<{ parentId: string; zoneId: string | null }> {
  const roleId = ROLE_ID[input.role];

  switch (input.role) {
    case "sub_admin": {
      assertCanCreate(me, scope, { roleId, zoneId: null });
      return { parentId: await findAdminId(me, tx), zoneId: null };
    }

    case "zonal_head": {
      const zoneId = input.zoneId ?? null;
      // A Zonal Head with no zone yet: Admin only (DEC-062).
      if (zoneId === null && me.roleId !== ROLE.ADMIN) refuse(me, "zonal_head_without_zone");
      assertCanCreate(me, scope, { roleId, zoneId });
      if (zoneId !== null) {
        const zone = await findActiveZone(tx, zoneId);
        const current = await findZonalHead(tx, zoneId);
        if (current) {
          throw new ConflictError(
            `Zone "${zone.name}" already has a Zonal Head (${current.name ?? "no name"})`
          );
        }
      }
      return { parentId: await findAdminId(me, tx), zoneId };
    }

    case "asm": {
      assertCanCreate(me, scope, { roleId, zoneId: input.zoneId });
      const zone = await findActiveZone(tx, input.zoneId);
      const zonalHead = await findZonalHead(tx, input.zoneId);
      if (!zonalHead) {
        throw new ConflictError(
          `Zone "${zone.name}" has no Zonal Head. Add the Zonal Head first, then the ASM.`
        );
      }
      return { parentId: zonalHead.id, zoneId: input.zoneId };
    }

    case "sales_executive": {
      let asmId = input.asmId;
      if (me.roleId === ROLE.ASM) {
        // An ASM adds Sales Executives under themselves only.
        if (asmId !== undefined && asmId !== me.id) refuse(me, "other_asm", { asmId });
        asmId = me.id;
      }
      if (asmId === undefined) {
        throw new ValidationError("Invalid request data", [
          { path: "body.asmId", message: "Choose the ASM this Sales Executive will report to" },
        ]);
      }

      // Load the ASM through the staff scope filter: an ASM outside my zone is a 404.
      const asm = assertInScope(
        await tx.user.findFirst({
          where: { AND: [{ id: asmId, roleId: ROLE.ASM }, scopeForStaff(me, scope)] },
          select: { id: true, status: true, zoneId: true, name: true },
        }),
        { user: me, entity: "ASM", id: asmId }
      );
      if (asm.status !== "active") {
        throw new ConflictError("This ASM is not active. Choose an active ASM.");
      }
      if (!asm.zoneId) throw new Error(`ASM ${asm.id} has no zone`);

      assertCanCreate(me, scope, { roleId, zoneId: asm.zoneId });
      await findActiveZone(tx, asm.zoneId);
      return { parentId: asm.id, zoneId: asm.zoneId };
    }
  }
}

/** POST /users — add a staff member (DEC-062). */
export async function createUser(me: AuthUser, input: CreateUserInput) {
  const scope = await scopeToCreate(me, input.role);
  const areas: SubAdminArea[] = input.role === "sub_admin" ? input.areas : [];

  const id = await prisma.$transaction(async (tx) => {
    const { parentId, zoneId } = await placeNewPerson(me, scope, input, tx);
    await assertContactFree(tx, input.phone, input.email);

    const created = await tx.user.create({
      data: {
        name: input.name,
        phone: input.phone,
        email: input.email ?? null,
        roleId: ROLE_ID[input.role],
        parentId,
        zoneId,
      },
      select: { id: true },
    });

    if (areas.length > 0) {
      await tx.subAdminAreaGrant.createMany({
        data: areas.map((area) => ({ userId: created.id, area, grantedById: me.id })),
      });
    }

    await recordAudit(tx, {
      actorId: me.id,
      action: "user.create",
      entity: { type: "user", id: created.id },
      after: {
        name: input.name,
        phone: input.phone,
        email: input.email ?? null,
        role: input.role,
        parentId,
        zoneId,
        ...(input.role === "sub_admin" && { areas }),
      },
    });
    return created.id;
  });

  const user = await prisma.user.findUniqueOrThrow({ where: { id }, select: STAFF_FIELDS });
  return toStaff(user);
}

// ---- Task 3: list, detail, picker (DEC-063) ----

/** "98765" also matches "919876543210", since `contains` looks anywhere in the phone. */
function searchStaff(search: string): Prisma.UserWhereInput {
  return {
    OR: [
      { name: { contains: search, mode: "insensitive" } },
      { phone: { contains: search } },
      { email: { contains: search, mode: "insensitive" } },
    ],
  };
}

/**
 * GET /users — the staff I may see (DEC-051): Admin all staff, Zonal Head their zone,
 * ASM themselves and their Sales Executives. Everyone by default, deactivated included.
 */
export async function listUsers(me: AuthUser, scope: PermissionScope, query: ListUsersQuery) {
  const where: Prisma.UserWhereInput = {
    AND: [
      scopeForStaff(me, scope),
      {
        ...(query.role && { roleId: STAFF_ROLE_ID[query.role] }),
        ...(query.zoneId && { zoneId: query.zoneId }),
        ...(query.status && { status: query.status }),
        ...(query.managerId && { parentId: query.managerId }),
      },
      ...(query.search ? [searchStaff(query.search)] : []),
    ],
  };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: STAFF_FIELDS,
      orderBy: toPrismaOrderBy(query.sort),
      ...toPrismaPaging(query.page, query.limit),
    }),
    prisma.user.count({ where }),
  ]);

  return { items: users.map(toStaff), meta: pageMeta(query.page, query.limit, total) };
}

/**
 * Active and suspended people under this person (DEC-063). Null for the Admin and
 * Sub-Admins, who have no team.
 */
async function countTeam(user: { id: string; roleId: number; zoneId: string | null }) {
  const count = (where: Prisma.UserWhereInput) =>
    prisma.user.count({ where: { ...where, ...NOT_DEACTIVATED } });

  switch (user.roleId) {
    case ROLE.ZONAL_HEAD: {
      if (!user.zoneId) return { asms: 0, salesExecutives: 0, partners: 0 };
      const inZone = (roleId: number) => count({ zoneId: user.zoneId, roleId });
      const [asms, salesExecutives, partners] = await Promise.all([
        inZone(ROLE.ASM),
        inZone(ROLE.SALES_EXECUTIVE),
        inZone(ROLE.PARTNER),
      ]);
      return { asms, salesExecutives, partners };
    }
    case ROLE.ASM: {
      const under = (roleId: number) => count({ parentId: user.id, roleId });
      const [salesExecutives, partners] = await Promise.all([
        under(ROLE.SALES_EXECUTIVE),
        under(ROLE.PARTNER),
      ]);
      return { salesExecutives, partners };
    }
    case ROLE.SALES_EXECUTIVE:
      return {
        partners: await count({
          roleId: ROLE.PARTNER,
          partnerProfile: { is: { salesExecutiveId: user.id } },
        }),
      };
    default:
      return null;
  }
}

/** GET /users/:id — one staff member I may see; anyone else is a 404. */
export async function getUser(me: AuthUser, scope: PermissionScope, id: string) {
  const user = assertInScope(
    await prisma.user.findFirst({
      where: { AND: [{ id }, scopeForStaff(me, scope)] },
      select: { ...STAFF_FIELDS, roleId: true, zoneId: true },
    }),
    { user: me, entity: "staff member", id }
  );

  const { roleId, zoneId, ...rest } = user;
  return { ...toStaff(rest), counts: await countTeam({ id, roleId, zoneId }) };
}

/**
 * GET /users/picker — for "assign to …" dropdowns (DEC-044 Q5, DEC-063).
 * Only active Zonal Heads, ASMs and Sales Executives; name, role and zone only.
 */
export async function pickStaff(query: PickerQuery) {
  const where: Prisma.UserWhereInput = {
    roleId: query.role
      ? STAFF_ROLE_ID[query.role]
      : { in: [ROLE.ZONAL_HEAD, ROLE.ASM, ROLE.SALES_EXECUTIVE] },
    status: "active",
    ...(query.zoneId && { zoneId: query.zoneId }),
    ...(query.search && { name: { contains: query.search, mode: "insensitive" } }),
  };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        role: { select: { key: true, name: true } },
        zone: { select: { id: true, name: true, code: true } },
      },
      orderBy: toPrismaOrderBy(query.sort),
      ...toPrismaPaging(query.page, query.limit),
    }),
    prisma.user.count({ where }),
  ]);

  return { items: users, meta: pageMeta(query.page, query.limit, total) };
}

// ---- Task 4: edit staff and "my profile" (DEC-064) ----

type ContactFields = { name?: string; phone?: string; email?: string | null };

/**
 * Saves only the fields that really change, with one audit row, in one transaction.
 * A new phone ends all the person's sessions (the phone is their login).
 */
async function saveContactChanges(
  actorId: string,
  action: "user.update" | "user.update_self",
  userId: string,
  input: ContactFields
) {
  const current = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { name: true, phone: true, email: true },
  });

  const changes: ContactFields = {};
  if (input.name !== undefined && input.name !== current.name) changes.name = input.name;
  if (input.phone !== undefined && input.phone !== current.phone) changes.phone = input.phone;
  if (input.email !== undefined && input.email !== current.email) changes.email = input.email;
  if (Object.keys(changes).length === 0) return { changed: false, sessionsEnded: 0 };

  return prisma.$transaction(async (tx) => {
    await assertContactFree(tx, changes.phone, changes.email, userId);
    await tx.user.update({ where: { id: userId }, data: changes });
    await recordAudit(tx, {
      actorId,
      action,
      entity: { type: "user", id: userId },
      before: Object.fromEntries(
        Object.keys(changes).map((key) => [key, current[key as keyof typeof current]])
      ),
      after: changes,
    });

    const sessionsEnded =
      changes.phone !== undefined
        ? await revokeAllSessions(tx, { userId, reason: "admin_revoked", actorId })
        : 0;
    return { changed: true, sessionsEnded };
  });
}

/**
 * PATCH /users/:id — Admin (any staff) or Zonal Head (their zone) edits name, phone, email
 * of someone strictly below them (DEC-052, DEC-064).
 */
export async function updateUser(
  me: AuthUser,
  scope: PermissionScope,
  id: string,
  input: UpdateUserInput
) {
  await assertCanManage(me, scope, "staff", id);
  const result = await saveContactChanges(me.id, "user.update", id, input);
  return { ...result, user: await getUser(me, scope, id) };
}

// ---- Task 5: switch staff off and on (DEC-065) ----

/** The action that allows switching each role off/on (DEC-044 Q6, DEC-056). */
const STATUS_ACTION: Partial<Record<number, Capability>> = {
  [ROLE.SUB_ADMIN]: "sub_admins.manage",
  [ROLE.ZONAL_HEAD]: "users.deactivate",
  [ROLE.ASM]: "users.deactivate",
  [ROLE.SALES_EXECUTIVE]: "sales_exec.deactivate",
};

/**
 * Checks that I may do an action on this staff member, and returns them with my scope.
 * The action depends on their role (`actions`: role id → action).
 * - Not a staff member, or someone I can't see → 404 (rule R2).
 * - Someone I can see but may not do this to (e.g. a Zonal Head looking at an ASM) → 403.
 * - Then the "only below me" rule (DEC-052).
 */
async function loadForAction(
  me: AuthUser,
  id: string,
  actions: Partial<Record<number, Capability>>
) {
  const target = await prisma.user.findUnique({ where: { id }, select: { roleId: true } });
  const capability = target ? actions[target.roleId] : undefined;
  const scope = capability ? await getPermissionScope(me, capability) : null;

  if (!scope) {
    const viewScope = await getPermissionScope(me, "users.view");
    const visible =
      viewScope &&
      (await prisma.user.findFirst({
        where: { AND: [{ id }, scopeForStaff(me, viewScope)] },
        select: { id: true },
      }));
    assertInScope(visible, { user: me, entity: "staff member", id });
    refuse(me, "no_permission_for_target", { targetId: id, capability });
  }

  return { target: await assertCanManage(me, scope, "staff", id), scope };
}

const loadForStatusChange = async (me: AuthUser, id: string) =>
  (await loadForAction(me, id, STATUS_ACTION)).target;

/** POST /users/:id/deactivate (DEC-065). Already deactivated → no change. */
export async function deactivateUser(me: AuthUser, id: string) {
  const target = await loadForStatusChange(me, id);
  if (target.status === "deactivated") {
    return { changed: false, partnersReturned: 0, user: await getStaffView(id) };
  }

  const partnersReturned = await prisma.$transaction(async (tx) => {
    let returned = 0;

    switch (target.roleId) {
      case ROLE.SALES_EXECUTIVE: {
        // Their partners go back to the ASM: the ASM already owns them, so only the
        // Sales Executive link is cleared (DEC-056).
        const result = await tx.partnerProfile.updateMany({
          where: { salesExecutiveId: id },
          data: { salesExecutiveId: null },
        });
        returned = result.count;
        // TODO(Modules 11–13): also hand leads, open tasks and pending requests to the ASM.
        break;
      }
      case ROLE.ASM: {
        const [salesExecutives, partners] = await Promise.all([
          tx.user.count({
            where: { parentId: id, roleId: ROLE.SALES_EXECUTIVE, ...NOT_DEACTIVATED },
          }),
          tx.user.count({ where: { parentId: id, roleId: ROLE.PARTNER, ...NOT_DEACTIVATED } }),
        ]);
        // TODO(Modules 11–13): also block on open leads, tasks and requests.
        if (salesExecutives > 0 || partners > 0) {
          throw new ConflictError(
            `This ASM still has ${salesExecutives} Sales Executive(s) and ${partners} partner(s). ` +
              "Move them to another ASM first."
          );
        }
        break;
      }
      case ROLE.ZONAL_HEAD: {
        if (target.zoneId) {
          const zone = await tx.zone.findUniqueOrThrow({
            where: { id: target.zoneId },
            select: { name: true },
          });
          throw new ConflictError(
            `This Zonal Head is in charge of zone "${zone.name}". ` +
              "Appoint a new Zonal Head for the zone first."
          );
        }
        const asms = await tx.user.count({
          where: { parentId: id, roleId: ROLE.ASM, ...NOT_DEACTIVATED },
        });
        if (asms > 0) {
          throw new ConflictError(`This Zonal Head still has ${asms} ASM(s) under them.`);
        }
        break;
      }
      // Sub-Admin: nothing to hand over; their areas are kept (DEC-065).
    }

    await tx.user.update({ where: { id }, data: { status: "deactivated" } });
    await recordAudit(tx, {
      actorId: me.id,
      action: "user.deactivate",
      entity: { type: "user", id },
      before: { status: target.status },
      after: {
        status: "deactivated",
        ...(target.roleId === ROLE.SALES_EXECUTIVE && { partnersReturned: returned }),
      },
    });
    await revokeAllSessions(tx, { userId: id, reason: "user_deactivated", actorId: me.id });
    return returned;
  });

  return { changed: true, partnersReturned, user: await getStaffView(id) };
}

/**
 * POST /users/:id/reactivate (DEC-065). Refused if their manager is not active, their
 * zone is inactive, or (Zonal Head) their zone already has another Zonal Head.
 */
export async function reactivateUser(me: AuthUser, id: string) {
  const target = await loadForStatusChange(me, id);
  if (target.status === "active") return { changed: false, user: await getStaffView(id) };

  await prisma.$transaction(async (tx) => {
    if (target.zoneId) {
      // Lock the zone so two Zonal Heads can't be switched on for it at the same time.
      await tx.$queryRaw`SELECT id FROM zones WHERE id = ${target.zoneId}::uuid FOR UPDATE`;
      const zone = await tx.zone.findUniqueOrThrow({
        where: { id: target.zoneId },
        select: { name: true, status: true },
      });
      if (zone.status !== "active") {
        throw new ConflictError(`Zone "${zone.name}" is inactive. Reactivate the zone first.`);
      }
      if (target.roleId === ROLE.ZONAL_HEAD) {
        const other = await tx.user.findFirst({
          where: {
            zoneId: target.zoneId,
            roleId: ROLE.ZONAL_HEAD,
            id: { not: id },
            ...NOT_DEACTIVATED,
          },
          select: { name: true },
        });
        if (other) {
          throw new ConflictError(
            `Zone "${zone.name}" already has a Zonal Head (${other.name ?? "no name"}).`
          );
        }
      }
    }

    if (target.parentId) {
      const manager = await tx.user.findUniqueOrThrow({
        where: { id: target.parentId },
        select: { name: true, status: true },
      });
      if (manager.status !== "active") {
        throw new ConflictError(
          `Their manager (${manager.name ?? "no name"}) is not active. ` +
            "Move them to an active manager first."
        );
      }
    }

    await tx.user.update({ where: { id }, data: { status: "active" } });
    await recordAudit(tx, {
      actorId: me.id,
      action: "user.reactivate",
      entity: { type: "user", id },
      before: { status: target.status },
      after: { status: "active" },
    });
  });

  return { changed: true, user: await getStaffView(id) };
}

// ---- Task 6: move staff (DEC-066) ----

/**
 * The action that allows moving each role. Zonal Heads and Sub-Admins are listed only
 * so the Admin gets a clear "not here" message instead of a 403.
 */
const TRANSFER_ACTION: Partial<Record<number, Capability>> = {
  [ROLE.SALES_EXECUTIVE]: "sales_exec.transfer",
  [ROLE.ASM]: "users.transfer",
  [ROLE.ZONAL_HEAD]: "users.transfer",
  [ROLE.SUB_ADMIN]: "sub_admins.manage",
};

/**
 * POST /users/:id/transfer (DEC-066).
 * - Sales Executive + `asmId`: Zonal Head (own zone) or Admin. Partners stay with the old ASM.
 * - ASM + `zoneId`: Admin only; refused while the ASM still has Sales Executives or partners.
 * Every move ends the person's sessions and is audited. Old records are not touched.
 */
export async function transferUser(me: AuthUser, id: string, input: TransferUserInput) {
  const { target, scope } = await loadForAction(me, id, TRANSFER_ACTION);

  if (target.roleId === ROLE.ZONAL_HEAD) {
    throw new ValidationError(
      "A Zonal Head is not moved here. Use 'replace Zonal Head' on the zone instead."
    );
  }
  if (target.roleId === ROLE.SUB_ADMIN) {
    throw new ValidationError("A Sub-Admin has no manager or zone to change.");
  }
  if (target.status === "deactivated") {
    throw new ConflictError("This person is deactivated. Reactivate them before moving them.");
  }

  if (target.roleId === ROLE.SALES_EXECUTIVE) {
    if (!input.asmId) {
      throw new ValidationError("Invalid request data", [
        { path: "body.asmId", message: "To move a Sales Executive, send the new ASM's id" },
      ]);
    }
    return moveSalesExecutive(me, scope, target, input.asmId);
  }

  if (!input.zoneId) {
    throw new ValidationError("Invalid request data", [
      { path: "body.zoneId", message: "To move an ASM, send the new zone's id" },
    ]);
  }
  // Moving an ASM always changes the zone, and transfers across zones are Admin only.
  if (scope !== "full") refuse(me, "asm_transfer_not_admin", { targetId: id });
  return moveAsm(me, target, input.zoneId);
}

type MoveTarget = { id: string; parentId: string | null; zoneId: string | null; status: string };

async function moveSalesExecutive(
  me: AuthUser,
  scope: PermissionScope,
  target: MoveTarget,
  asmId: string
) {
  if (asmId === target.parentId) {
    throw new ConflictError("This Sales Executive already reports to that ASM.");
  }

  const partnersUnassigned = await prisma.$transaction(async (tx) => {
    // The new ASM must be one I can see: a Zonal Head only finds ASMs in their zone.
    const asm = assertInScope(
      await tx.user.findFirst({
        where: { AND: [{ id: asmId, roleId: ROLE.ASM }, scopeForStaff(me, scope)] },
        select: { id: true, status: true, zoneId: true },
      }),
      { user: me, entity: "ASM", id: asmId }
    );
    if (asm.status !== "active") {
      throw new ConflictError("The new ASM is not active. Choose an active ASM.");
    }
    if (!asm.zoneId) throw new Error(`ASM ${asm.id} has no zone`);
    await findActiveZone(tx, asm.zoneId);

    // Partners stay with the old ASM, with no Sales Executive (DEC-056, DEC-066).
    const { count } = await tx.partnerProfile.updateMany({
      where: { salesExecutiveId: target.id },
      data: { salesExecutiveId: null },
    });

    await tx.user.update({
      where: { id: target.id },
      data: { parentId: asm.id, zoneId: asm.zoneId },
    });
    await recordAudit(tx, {
      actorId: me.id,
      action: "user.transfer",
      entity: { type: "user", id: target.id },
      before: { parentId: target.parentId, zoneId: target.zoneId },
      after: { parentId: asm.id, zoneId: asm.zoneId, partnersUnassigned: count },
    });
    await revokeAllSessions(tx, { userId: target.id, reason: "admin_revoked", actorId: me.id });
    return count;
  });

  return { partnersUnassigned, user: await getStaffView(target.id) };
}

async function moveAsm(me: AuthUser, target: MoveTarget, zoneId: string) {
  if (zoneId === target.zoneId) throw new ConflictError("This ASM is already in that zone.");

  await prisma.$transaction(async (tx) => {
    const [salesExecutives, partners] = await Promise.all([
      tx.user.count({
        where: { parentId: target.id, roleId: ROLE.SALES_EXECUTIVE, ...NOT_DEACTIVATED },
      }),
      tx.user.count({ where: { parentId: target.id, roleId: ROLE.PARTNER, ...NOT_DEACTIVATED } }),
    ]);
    if (salesExecutives > 0 || partners > 0) {
      throw new ConflictError(
        `This ASM still has ${salesExecutives} Sales Executive(s) and ${partners} partner(s). ` +
          "Move them to another ASM first."
      );
    }

    const zone = await findActiveZone(tx, zoneId);
    const zonalHead = await findZonalHead(tx, zoneId);
    if (!zonalHead) {
      throw new ConflictError(
        `Zone "${zone.name}" has no Zonal Head. Appoint the Zonal Head first, then move the ASM.`
      );
    }

    await tx.user.update({ where: { id: target.id }, data: { parentId: zonalHead.id, zoneId } });
    await recordAudit(tx, {
      actorId: me.id,
      action: "user.transfer",
      entity: { type: "user", id: target.id },
      before: { parentId: target.parentId, zoneId: target.zoneId },
      after: { parentId: zonalHead.id, zoneId },
    });
    await revokeAllSessions(tx, { userId: target.id, reason: "admin_revoked", actorId: me.id });
  });

  return { partnersUnassigned: 0, user: await getStaffView(target.id) };
}

/** A staff member in the usual reply shape (no scope check: callers have done it). */
async function getStaffView(id: string) {
  return toStaff(await prisma.user.findUniqueOrThrow({ where: { id }, select: STAFF_FIELDS }));
}

/** PATCH /users/me — my own name and email (never the phone, DEC-064). */
export async function updateMe(me: AuthUser, input: UpdateMeInput) {
  const { changed } = await saveContactChanges(me.id, "user.update_self", me.id, input);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: me.id }, select: STAFF_FIELDS });
  return { changed, user: toStaff(user) };
}

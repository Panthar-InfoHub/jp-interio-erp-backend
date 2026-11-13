import { ROLE } from "../config/roles.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { PermissionScope } from "../generated/prisma/enums.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { scopeForStaff } from "./scope.service.js";

/**
 * Org tree (Module 4, Task 10; DEC-070): Zone → Zonal Head → ASMs → Sales Executives.
 * - Only active and suspended people, only active zones. Partners appear as counts.
 * - Admin: all zones + a "No zone" section (Sub-Admins, Zonal Heads with no zone).
 * - Zonal Head: their zone. ASM: themselves and their Sales Executives (`team`).
 * Built from a handful of queries, not one per node.
 */

const NOT_DEACTIVATED = { status: { not: "deactivated" } } satisfies Prisma.UserWhereInput;

type Person = {
  id: string;
  name: string | null;
  status: string;
  roleId: number;
  zoneId: string | null;
  parentId: string | null;
};

const person = ({ id, name, status }: Person) => ({ id, name, status });

/** Partner counts by owning ASM, by Sales Executive and by zone (deactivated left out). */
async function partnerCounts(asmIds: string[], seIds: string[], zoneIds: string[]) {
  const partners = { roleId: ROLE.PARTNER, ...NOT_DEACTIVATED } satisfies Prisma.UserWhereInput;
  const [byAsm, bySe, byZone] = await Promise.all([
    asmIds.length
      ? prisma.user.groupBy({
          by: ["parentId"],
          where: { ...partners, parentId: { in: asmIds } },
          _count: { _all: true },
        })
      : [],
    seIds.length
      ? prisma.partnerProfile.groupBy({
          by: ["salesExecutiveId"],
          where: { salesExecutiveId: { in: seIds }, user: partners },
          _count: { _all: true },
        })
      : [],
    zoneIds.length
      ? prisma.user.groupBy({
          by: ["zoneId"],
          where: { ...partners, zoneId: { in: zoneIds } },
          _count: { _all: true },
        })
      : [],
  ]);

  const toMap = <K extends string>(
    rows: ({ _count: { _all: number } } & Record<K, unknown>)[],
    key: K
  ) => new Map(rows.map((row) => [row[key] as string, row._count._all]));
  return {
    ofAsm: toMap(byAsm, "parentId"),
    ofSe: toMap(bySe, "salesExecutiveId"),
    ofZone: toMap(byZone, "zoneId"),
  };
}

type Counts = Awaited<ReturnType<typeof partnerCounts>>;

function seNode(se: Person, counts: Counts) {
  return { ...person(se), counts: { partners: counts.ofSe.get(se.id) ?? 0 } };
}

function asmNode(asm: Person, staff: Person[], counts: Counts) {
  const salesExecutives = staff
    .filter((p) => p.roleId === ROLE.SALES_EXECUTIVE && p.parentId === asm.id)
    .map((se) => seNode(se, counts));
  return {
    ...person(asm),
    noSalesExecutives: salesExecutives.length === 0,
    counts: {
      salesExecutives: salesExecutives.length,
      partners: counts.ofAsm.get(asm.id) ?? 0,
    },
    salesExecutives,
  };
}

function zoneNode(
  zone: { id: string; name: string; code: string },
  staff: Person[],
  counts: Counts
) {
  const inZone = staff.filter((p) => p.zoneId === zone.id);
  const head = inZone.find((p) => p.roleId === ROLE.ZONAL_HEAD) ?? null;
  const asms = inZone
    .filter((p) => p.roleId === ROLE.ASM)
    .map((asm) => asmNode(asm, staff, counts));
  const underHead = head
    ? asms.filter((asm) => inZone.find((p) => p.id === asm.id)?.parentId === head.id)
    : [];

  return {
    ...zone,
    noZonalHead: head === null,
    counts: {
      asms: asms.length,
      salesExecutives: inZone.filter((p) => p.roleId === ROLE.SALES_EXECUTIVE).length,
      partners: counts.ofZone.get(zone.id) ?? 0,
    },
    zonalHead: head && { ...person(head), asms: underHead },
    // Normally empty: ASMs whose manager is not the zone's Zonal Head (e.g. no Zonal Head).
    otherAsms: asms.filter((asm) => !underHead.includes(asm)),
  };
}

/** GET /org/tree */
export async function getOrgTree(me: AuthUser, scope: PermissionScope) {
  const staff: Person[] = await prisma.user.findMany({
    where: {
      AND: [
        scopeForStaff(me, scope),
        NOT_DEACTIVATED,
        { roleId: { in: [ROLE.SUB_ADMIN, ROLE.ZONAL_HEAD, ROLE.ASM, ROLE.SALES_EXECUTIVE] } },
      ],
    },
    select: { id: true, name: true, status: true, roleId: true, zoneId: true, parentId: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });

  const asmIds = staff.filter((p) => p.roleId === ROLE.ASM).map((p) => p.id);
  const seIds = staff.filter((p) => p.roleId === ROLE.SALES_EXECUTIVE).map((p) => p.id);

  // ASM: only their own team, no zone view (they can't see the Zonal Head).
  if (me.roleId === ROLE.ASM) {
    const counts = await partnerCounts(asmIds, seIds, []);
    const self = staff.find((p) => p.id === me.id);
    return {
      view: "team" as const,
      zones: [],
      noZone: null,
      team: self ? asmNode(self, staff, counts) : null,
    };
  }

  // A Zonal Head with no zone (between replacements) sees no zone at all.
  const zones =
    scope !== "full" && !me.zoneId
      ? []
      : await prisma.zone.findMany({
          where: { status: "active", ...(scope !== "full" && { id: me.zoneId! }) },
          select: { id: true, name: true, code: true },
          orderBy: [{ name: "asc" }, { id: "asc" }],
        });
  const counts = await partnerCounts(
    asmIds,
    seIds,
    zones.map((zone) => zone.id)
  );

  return {
    view: scope === "full" ? ("all" as const) : ("zone" as const),
    zones: zones.map((zone) => zoneNode(zone, staff, counts)),
    noZone:
      scope === "full"
        ? {
            subAdmins: staff.filter((p) => p.roleId === ROLE.SUB_ADMIN).map(person),
            zonalHeads: staff
              .filter((p) => p.roleId === ROLE.ZONAL_HEAD && p.zoneId === null)
              .map(person),
          }
        : null,
    team: null,
  };
}

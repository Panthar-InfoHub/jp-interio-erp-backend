/**
 * DEV ONLY (DEC-047). Adds a small pretend company to the dev database so every
 * role can be tried by hand (Apidog, scope check scripts). Run with
 * `npm run db:dev-data`, after `npm run db:seed`.
 *
 * - Refuses to run when NODE_ENV=production.
 * - Safe to run again: it only adds what is missing and never changes or deletes
 *   anything that already exists.
 * - Everything runs in one transaction; every new record writes an audit row with
 *   an empty actor ("system") and `source: "dev-data"`.
 * - All names start with "TEST"; zone codes are TPUNE and TMUM.
 * - Every phone must be added to TEST_PHONES in .env to log in (with TEST_OTP).
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { isProd } from "../src/config/env.js";
import { ROLE, ROLES, type RoleId } from "../src/config/roles.js";
import type {
  KycState,
  PartnerType,
  SubAdminArea,
  UserStatus,
} from "../src/generated/prisma/enums.js";
import { recordAudit } from "../src/services/audit.service.js";
import { openWallet } from "../src/services/wallet.service.js";
import { normalizePhone } from "../src/utils/phone.js";

const SOURCE = "dev-data";

// ---------------------------------------------------------------------------
// The pretend company
// ---------------------------------------------------------------------------

interface ZoneSpec {
  code: string;
  name: string;
  region: string;
  state: string;
}

const ZONES: ZoneSpec[] = [
  { code: "TPUNE", name: "TEST Pune", region: "West", state: "Maharashtra" },
  { code: "TMUM", name: "TEST Mumbai", region: "West", state: "Maharashtra" },
];

interface PartnerSpec {
  businessName: string;
  partnerType: PartnerType;
  city: string;
  kycState: KycState;
  /** Key of the assigned Sales Executive, if any. */
  salesExecutive?: string;
}

interface PersonSpec {
  /** Short key used to link people below. */
  key: string;
  name: string;
  roleId: RoleId;
  /** 10-digit mobile, as typed in Apidog. */
  phone: string;
  /** Key of the manager. Empty = the Admin (for Sub-Admins and Zonal Heads). */
  parent?: string;
  zone?: string;
  status?: UserStatus;
  areas?: SubAdminArea[];
  partner?: PartnerSpec;
  note: string;
}

/** Order matters: everyone comes after their manager. */
const PEOPLE: PersonSpec[] = [
  {
    key: "sa_partners",
    name: "TEST Sub-Admin Partners",
    roleId: ROLE.SUB_ADMIN,
    phone: "9000000101",
    areas: ["partners"],
    note: "area: Partners & KYC",
  },
  {
    key: "sa_rewards",
    name: "TEST Sub-Admin Rewards",
    roleId: ROLE.SUB_ADMIN,
    phone: "9000000102",
    areas: ["rewards"],
    note: "area: Rewards & Payouts",
  },
  {
    key: "sa_none",
    name: "TEST Sub-Admin No Areas",
    roleId: ROLE.SUB_ADMIN,
    phone: "9000000103",
    areas: [],
    note: "no areas (should be refused everywhere)",
  },
  {
    key: "sa_products",
    name: "TEST Sub-Admin Products",
    roleId: ROLE.SUB_ADMIN,
    phone: "9000000105",
    areas: ["products"],
    note: "area: Products & Catalog (Module 6 testing, DEC-116)",
  },
  {
    key: "sa_qr",
    name: "TEST Sub-Admin QR",
    roleId: ROLE.SUB_ADMIN,
    phone: "9000000106",
    areas: ["qr"],
    note: "area: QR Batches (Module 7 testing, DEC-126)",
  },
  {
    key: "zh_pune",
    name: "TEST Pune ZH",
    roleId: ROLE.ZONAL_HEAD,
    phone: "9000000111",
    zone: "TPUNE",
    note: "",
  },
  {
    key: "zh_mumbai",
    name: "TEST Mumbai ZH",
    roleId: ROLE.ZONAL_HEAD,
    phone: "9000000112",
    zone: "TMUM",
    note: "",
  },
  {
    key: "asm_pune_1",
    name: "TEST Pune ASM 1",
    roleId: ROLE.ASM,
    phone: "9000000121",
    parent: "zh_pune",
    zone: "TPUNE",
    note: "has 2 Sales Executives",
  },
  {
    key: "asm_pune_2",
    name: "TEST Pune ASM 2",
    roleId: ROLE.ASM,
    phone: "9000000122",
    parent: "zh_pune",
    zone: "TPUNE",
    note: "no Sales Executives",
  },
  {
    key: "asm_mumbai_1",
    name: "TEST Mumbai ASM 1",
    roleId: ROLE.ASM,
    phone: "9000000123",
    parent: "zh_mumbai",
    zone: "TMUM",
    note: "",
  },
  {
    key: "se_1",
    name: "TEST SE 1",
    roleId: ROLE.SALES_EXECUTIVE,
    phone: "9000000131",
    parent: "asm_pune_1",
    zone: "TPUNE",
    note: "",
  },
  {
    key: "se_2",
    name: "TEST SE 2",
    roleId: ROLE.SALES_EXECUTIVE,
    phone: "9000000132",
    parent: "asm_pune_1",
    zone: "TPUNE",
    note: "",
  },
  {
    key: "partner_a",
    name: "TEST Partner A",
    roleId: ROLE.PARTNER,
    phone: "9000000141",
    parent: "asm_pune_1",
    zone: "TPUNE",
    partner: {
      businessName: "TEST A Carpentry",
      partnerType: "carpenter",
      city: "Pune",
      kycState: "verified",
      salesExecutive: "se_1",
    },
    note: "SE 1, KYC verified",
  },
  {
    key: "partner_b",
    name: "TEST Partner B",
    roleId: ROLE.PARTNER,
    phone: "9000000142",
    parent: "asm_pune_1",
    zone: "TPUNE",
    partner: {
      businessName: "TEST B Traders",
      partnerType: "dealer",
      city: "Pune",
      kycState: "pending",
      salesExecutive: "se_2",
    },
    note: "SE 2, KYC pending",
  },
  {
    key: "partner_c",
    name: "TEST Partner C",
    roleId: ROLE.PARTNER,
    phone: "9000000143",
    parent: "asm_pune_1",
    zone: "TPUNE",
    partner: {
      businessName: "TEST C Furniture",
      partnerType: "oem",
      city: "Pune",
      kycState: "verified",
    },
    note: "no SE, KYC verified",
  },
  {
    key: "partner_d",
    name: "TEST Partner D",
    roleId: ROLE.PARTNER,
    phone: "9000000144",
    parent: "asm_pune_2",
    zone: "TPUNE",
    partner: {
      businessName: "TEST D Carpentry",
      partnerType: "carpenter",
      city: "Pune",
      kycState: "not_submitted",
    },
    note: "KYC not submitted",
  },
  {
    key: "partner_e",
    name: "TEST Partner E",
    roleId: ROLE.PARTNER,
    phone: "9000000145",
    parent: "asm_mumbai_1",
    zone: "TMUM",
    partner: {
      businessName: "TEST E Interiors",
      partnerType: "dealer",
      city: "Mumbai",
      kycState: "verified",
    },
    note: "KYC verified",
  },
  {
    key: "partner_f",
    name: "TEST Partner F",
    roleId: ROLE.PARTNER,
    phone: "9000000146",
    parent: "asm_pune_2",
    zone: "TPUNE",
    status: "suspended",
    partner: {
      businessName: "TEST F Woodworks",
      partnerType: "carpenter",
      city: "Pune",
      kycState: "verified",
    },
    note: "KYC verified, SUSPENDED",
  },
];

// ---------------------------------------------------------------------------

const roleName = new Map<number, string>(ROLES.map((role) => [role.id, role.name]));

function toStoredPhone(phone: string): string {
  const stored = normalizePhone(phone);
  if (!stored) throw new Error(`Bad test phone in the list: ${phone}`);
  return stored;
}

async function main(): Promise<void> {
  if (isProd) {
    console.error(
      "❌ Stopped: dev test data must never be added in production (NODE_ENV=production)."
    );
    process.exitCode = 1;
    return;
  }

  const summary = await prisma.$transaction(
    async (tx) => {
      const admin = await tx.user.findFirst({
        where: { roleId: ROLE.ADMIN },
        orderBy: { createdAt: "asc" },
      });
      if (!admin) throw new Error("No Admin found. Run `npm run db:seed` first.");

      // ---- 1. Zones ----
      const zoneIds = new Map<string, string>();
      let zonesAdded = 0;
      for (const spec of ZONES) {
        const existing = await tx.zone.findUnique({ where: { code: spec.code } });
        if (existing) {
          zoneIds.set(spec.code, existing.id);
          continue;
        }
        const zone = await tx.zone.create({ data: { ...spec } });
        await recordAudit(tx, {
          actorId: null,
          action: "zone.create",
          entity: { type: "zone", id: zone.id },
          after: { ...spec, status: zone.status, source: SOURCE },
        });
        zoneIds.set(spec.code, zone.id);
        zonesAdded++;
      }

      // ---- 2. People ----
      const userIds = new Map<string, string>();
      let peopleAdded = 0;
      let areasAdded = 0;

      for (const spec of PEOPLE) {
        const phone = toStoredPhone(spec.phone);
        const parentId = spec.parent ? userIds.get(spec.parent) : admin.id;
        if (!parentId) throw new Error(`${spec.name}: manager "${spec.parent}" not found`);
        const zoneId = spec.zone ? zoneIds.get(spec.zone) : undefined;
        if (spec.zone && !zoneId) throw new Error(`${spec.name}: zone "${spec.zone}" not found`);

        let userId: string;
        const existing = await tx.user.findUnique({ where: { phone } });

        if (existing) {
          // Never change existing data; only make sure it is not someone else's phone.
          if (existing.roleId !== spec.roleId) {
            throw new Error(
              `Phone ${spec.phone} already belongs to a ${roleName.get(existing.roleId)} ` +
                `("${existing.name ?? "no name"}"), not a ${roleName.get(spec.roleId)}. Nothing was saved.`
            );
          }
          userId = existing.id;
        } else {
          // One Zonal Head per zone (DEC-019, checked in code per DEC-026).
          if (spec.roleId === ROLE.ZONAL_HEAD) {
            const otherHead = await tx.user.findFirst({
              where: {
                roleId: ROLE.ZONAL_HEAD,
                zoneId: zoneId ?? null,
                status: { not: "deactivated" },
              },
            });
            if (otherHead) {
              throw new Error(
                `Zone ${spec.zone} already has a Zonal Head (${otherHead.phone}). Nothing was saved.`
              );
            }
          }

          const user = await tx.user.create({
            data: {
              name: spec.name,
              phone,
              roleId: spec.roleId,
              parentId,
              zoneId: zoneId ?? null,
              status: spec.status ?? "active",
            },
          });
          await recordAudit(tx, {
            actorId: null,
            action: "user.create",
            entity: { type: "user", id: user.id },
            after: {
              name: user.name,
              phone: user.phone,
              roleId: user.roleId,
              parentId: user.parentId,
              zoneId: user.zoneId,
              status: user.status,
              source: SOURCE,
            },
          });
          userId = user.id;
          peopleAdded++;
        }
        userIds.set(spec.key, userId);

        // Partner profile (only if missing).
        if (spec.partner) {
          const profile = await tx.partnerProfile.findUnique({ where: { userId } });
          if (!profile) {
            const salesExecutiveId = spec.partner.salesExecutive
              ? userIds.get(spec.partner.salesExecutive)
              : undefined;
            if (spec.partner.salesExecutive && !salesExecutiveId) {
              throw new Error(
                `${spec.name}: Sales Executive "${spec.partner.salesExecutive}" not found`
              );
            }
            const data = {
              businessName: spec.partner.businessName,
              partnerType: spec.partner.partnerType,
              city: spec.partner.city,
              state: "Maharashtra",
              kycState: spec.partner.kycState,
              salesExecutiveId: salesExecutiveId ?? null,
              // Onboarded by the SE if assigned, otherwise by the owning ASM (DEC-004).
              onboardedById: salesExecutiveId ?? parentId,
            };
            await tx.partnerProfile.create({ data: { userId, ...data } });
            await recordAudit(tx, {
              actorId: null,
              action: "partner_profile.create",
              entity: { type: "partner_profile", id: userId },
              after: { ...data, source: SOURCE },
            });
          }
        }

        // Sub-Admin areas (only missing ones are added).
        for (const area of spec.areas ?? []) {
          const grant = await tx.subAdminAreaGrant.findUnique({
            where: { userId_area: { userId, area } },
          });
          if (grant) continue;
          await tx.subAdminAreaGrant.create({ data: { userId, area, grantedById: admin.id } });
          await recordAudit(tx, {
            actorId: null,
            action: "sub_admin_area.grant",
            entity: { type: "user", id: userId },
            after: { area, grantedById: admin.id, source: SOURCE },
          });
          areasAdded++;
        }
      }

      // ---- 3. Wallets for the verified test partners (Module 8, DEC-132) ----
      let walletsOpened = 0;
      for (const spec of PEOPLE) {
        if (spec.partner?.kycState !== "verified") continue;
        const userId = userIds.get(spec.key);
        if (!userId) continue;
        // Only if this test partner really is verified in the database (data is never changed).
        const profile = await tx.partnerProfile.findUnique({
          where: { userId },
          select: { kycState: true },
        });
        if (profile?.kycState !== "verified") continue;
        if (!(await openWallet(tx, userId))) continue;
        await recordAudit(tx, {
          actorId: null,
          action: "wallet.open",
          entity: { type: "partner", id: userId },
          after: { available: 0, held: 0, source: SOURCE },
        });
        walletsOpened++;
      }

      return { zonesAdded, peopleAdded, areasAdded, walletsOpened };
    },
    // Neon can be slow while it wakes up; this transaction makes many small queries.
    { maxWait: 15_000, timeout: 90_000 }
  );

  const nameByKey = new Map(PEOPLE.map((person) => [person.key, person.name]));
  console.log("✅ Dev test data ready");
  console.log(
    `   Zones: ${summary.zonesAdded} added · People: ${summary.peopleAdded} added · ` +
      `Sub-Admin areas: ${summary.areasAdded} added · Wallets: ${summary.walletsOpened} opened ` +
      `(the rest already existed)\n`
  );
  console.table(
    PEOPLE.map((person) => ({
      name: person.name,
      role: roleName.get(person.roleId),
      phone: person.phone,
      zone: person.zone ?? "—",
      manager: person.parent ? nameByKey.get(person.parent) : "Admin",
      note: person.note,
    }))
  );
  console.log(
    "\nTo log in as these people, add these numbers to TEST_PHONES in .env " +
      "(keep any numbers already there; they all use TEST_OTP), then restart the server:"
  );
  console.log(PEOPLE.map((person) => person.phone).join(","));
}

try {
  await main();
} catch (error) {
  console.error(
    "❌ Dev data failed, nothing was saved:",
    error instanceof Error
      ? error.message
      : "could not connect to the database (it may be waking up). Try again in a few seconds."
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

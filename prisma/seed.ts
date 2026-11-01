/**
 * Fills a fresh database with the starting data: the 6 roles, the first Admin
 * (from .env) and the default settings. Run with `npm run db:seed`.
 *
 * Safe to run again: it only adds what is missing. Existing settings are never
 * overwritten (the Admin may have changed them), and no second Admin is created.
 * Everything runs in one transaction, and every change writes an audit row with
 * an empty actor ("system").
 */
import "dotenv/config";
import { z } from "zod";
import { prisma } from "../src/lib/prisma.js";
import { ROLE, ROLES } from "../src/config/roles.js";
import { SETTINGS, type SettingKey } from "../src/config/settings.js";
import { recordAudit } from "../src/services/audit.service.js";
import { normalizePhone } from "../src/utils/phone.js";

const seedEnvSchema = z.object({
  SEED_ADMIN_NAME: z.string().trim().min(1, "is required").max(100),
  SEED_ADMIN_PHONE: z.string().transform((value, ctx) => {
    const phone = normalizePhone(value);
    if (!phone) {
      ctx.addIssue({ code: "custom", message: "must be a valid 10-digit Indian mobile number" });
      return z.NEVER;
    }
    return phone;
  }),
  SEED_ADMIN_EMAIL: z
    .string()
    .trim()
    .toLowerCase()
    .optional()
    .transform((value) => value || undefined)
    .pipe(z.email("must be a valid email").max(255).optional()),
});

/** Settings are stored as text; this is the text form of a default value. */
function toStoredValue(type: string, value: unknown): string {
  return type === "json" ? JSON.stringify(value) : String(value);
}

async function main(): Promise<void> {
  const parsedEnv = seedEnvSchema.safeParse(process.env);
  if (!parsedEnv.success) {
    console.error("❌ Seed stopped: fix these values in .env\n");
    console.error(z.prettifyError(parsedEnv.error));
    process.exitCode = 1;
    return;
  }
  const admin = parsedEnv.data;

  const summary = await prisma.$transaction(
    async (tx) => {
      // ---- 1. Roles: add missing ones, correct changed ones ----
      let rolesAdded = 0;
      let rolesUpdated = 0;
      for (const role of ROLES) {
        const existing = await tx.role.findUnique({ where: { id: role.id } });
        if (!existing) {
          await tx.role.create({ data: { ...role } });
          await recordAudit(tx, {
            actorId: null,
            action: "role.create",
            entity: { type: "role", id: String(role.id) },
            after: { ...role },
          });
          rolesAdded++;
          continue;
        }

        const changed =
          existing.key !== role.key ||
          existing.name !== role.name ||
          existing.tier !== role.tier ||
          existing.app !== role.app;
        if (changed) {
          await tx.role.update({ where: { id: role.id }, data: { ...role } });
          await recordAudit(tx, {
            actorId: null,
            action: "role.update",
            entity: { type: "role", id: String(role.id) },
            before: {
              key: existing.key,
              name: existing.name,
              tier: existing.tier,
              app: existing.app,
            },
            after: { key: role.key, name: role.name, tier: role.tier, app: role.app },
          });
          rolesUpdated++;
        }
      }

      // ---- 2. First Admin: only if no Admin exists yet ----
      let adminResult: string;
      const existingAdmin = await tx.user.findFirst({
        where: { roleId: ROLE.ADMIN },
        orderBy: { createdAt: "asc" },
      });

      if (existingAdmin) {
        adminResult = `already exists (${existingAdmin.phone}), skipped`;
        if (existingAdmin.phone !== admin.SEED_ADMIN_PHONE) {
          adminResult += `. Note: .env has ${admin.SEED_ADMIN_PHONE}, which was NOT used`;
        }
      } else {
        // One phone = one account = one role (DEC-022).
        const phoneOwner = await tx.user.findUnique({ where: { phone: admin.SEED_ADMIN_PHONE } });
        if (phoneOwner) {
          throw new Error(`Phone ${admin.SEED_ADMIN_PHONE} already belongs to another user`);
        }
        if (admin.SEED_ADMIN_EMAIL) {
          const emailOwner = await tx.user.findUnique({ where: { email: admin.SEED_ADMIN_EMAIL } });
          if (emailOwner) {
            throw new Error(`Email ${admin.SEED_ADMIN_EMAIL} already belongs to another user`);
          }
        }

        const created = await tx.user.create({
          data: {
            name: admin.SEED_ADMIN_NAME,
            phone: admin.SEED_ADMIN_PHONE,
            email: admin.SEED_ADMIN_EMAIL ?? null,
            roleId: ROLE.ADMIN,
          },
        });
        await recordAudit(tx, {
          actorId: null,
          action: "user.create",
          entity: { type: "user", id: created.id },
          after: {
            name: created.name,
            phone: created.phone,
            email: created.email,
            roleId: created.roleId,
            status: created.status,
          },
        });
        adminResult = `created (${created.phone})`;
      }

      // ---- 3. Settings: add missing ones only, never overwrite ----
      const keys = Object.keys(SETTINGS) as SettingKey[];
      const existingSettings = await tx.setting.findMany({ where: { key: { in: keys } } });
      const existingByKey = new Map(existingSettings.map((setting) => [setting.key, setting]));

      let settingsAdded = 0;
      const warnings: string[] = [];
      for (const key of keys) {
        const definition = SETTINGS[key];
        const existing = existingByKey.get(key);

        if (existing) {
          if (existing.type !== definition.type) {
            warnings.push(
              `Setting ${key} is stored as ${existing.type} but the code expects ${definition.type}`
            );
          }
          continue;
        }

        const value = toStoredValue(definition.type, definition.default);
        await tx.setting.create({
          data: { key, value, type: definition.type, description: definition.description },
        });
        await recordAudit(tx, {
          actorId: null,
          action: "setting.create",
          entity: { type: "setting", id: key },
          after: { value, type: definition.type },
        });
        settingsAdded++;
      }

      return {
        rolesAdded,
        rolesUpdated,
        rolesTotal: ROLES.length,
        adminResult,
        settingsAdded,
        settingsExisting: keys.length - settingsAdded,
        warnings,
      };
    },
    // Neon can be slow while it wakes up.
    { maxWait: 15_000, timeout: 30_000 }
  );

  console.log("✅ Seed finished");
  console.log(
    `   Roles:    ${summary.rolesAdded} added, ${summary.rolesUpdated} updated, ` +
      `${summary.rolesTotal - summary.rolesAdded - summary.rolesUpdated} already correct`
  );
  console.log(`   Admin:    ${summary.adminResult}`);
  console.log(
    `   Settings: ${summary.settingsAdded} added, ${summary.settingsExisting} already there (kept as is)`
  );
  for (const warning of summary.warnings) console.warn(`⚠️  ${warning}`);
}

try {
  await main();
} catch (error) {
  console.error(
    "❌ Seed failed, nothing was saved:",
    // The Neon driver reports "can't connect" as a non-Error event, often while it wakes up.
    error instanceof Error
      ? error.message
      : "could not connect to the database (it may be waking up). Try again in a few seconds."
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

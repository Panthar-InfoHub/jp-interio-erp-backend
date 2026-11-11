import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { AppError, NotFoundError, ValidationError } from "../utils/errors.js";
import type { SettingType } from "../generated/prisma/enums.js";
import {
  SETTINGS,
  SETTING_KEYS,
  isSettingKey,
  type SettingDefinition,
  type SettingKey,
  type SettingValue,
} from "../config/settings.js";
import { recordAudit } from "./audit.service.js";

// How long a value is remembered before the database is read again (DEC-029).
const CACHE_TTL_MS = 60_000;

const cache = new Map<SettingKey, { value: unknown; expiresAt: number }>();

/** A missing or broken setting is a server problem (500), never a silent default (DEC-029). */
class SettingError extends AppError {
  constructor(message: string) {
    super(message, 500, "SETTING_ERROR");
  }
}

/** Turns the stored text into the setting's real type, or throws if the text is broken. */
function parseValue(key: SettingKey, type: SettingType, raw: string): unknown {
  switch (type) {
    case "int": {
      const value = Number(raw);
      if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(value)) break;
      return value;
    }
    case "bool":
      if (raw === "true") return true;
      if (raw === "false") return false;
      break;
    case "string":
      return raw;
    case "json":
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        break;
      }
  }
  throw new SettingError(`Setting ${key} has an invalid ${type} value`);
}

/**
 * Reads a business setting, e.g. `await getSetting("payout.min_points")` → 100.
 * Remembered for 60 seconds; call `clearSettingsCache(key)` after changing it.
 */
export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value as SettingValue<K>;
  }

  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row) {
    throw new SettingError(`Setting ${key} is missing. Run the seed (npm run db:seed).`);
  }

  const expectedType = SETTINGS[key].type;
  if (row.type !== expectedType) {
    throw new SettingError(`Setting ${key} is stored as ${row.type}, expected ${expectedType}`);
  }

  const value = parseValue(key, row.type, row.value);
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value as SettingValue<K>;
}

/** Forget remembered values so the next read comes from the database. No key = forget all. */
export function clearSettingsCache(key?: SettingKey): void {
  if (key) cache.delete(key);
  else cache.clear();
}

// ---- Admin: see and change settings (DEC-054) ----

type SettingRow = {
  key: string;
  value: string;
  type: SettingType;
  updatedAt: Date;
  updatedBy: { id: string; name: string | null } | null;
};

const rowSelect = {
  key: true,
  value: true,
  type: true,
  updatedAt: true,
  updatedBy: { select: { id: true, name: true } },
} as const;

/** One setting as the Admin screen sees it: value plus everything needed to build the form. */
function toView(key: SettingKey, row: SettingRow | undefined) {
  const definition: SettingDefinition = SETTINGS[key];
  let value: unknown = null;
  if (row) {
    try {
      value = parseValue(key, row.type, row.value);
    } catch {
      // Shown as null so the Admin can fix it with PATCH; getSetting() still fails loudly.
      logger.warn({ key }, "Setting has an invalid stored value");
    }
  }
  return {
    key,
    value,
    type: definition.type,
    description: definition.description,
    min: definition.min ?? null,
    max: definition.max ?? null,
    default: definition.default,
    readOnly: definition.readOnly ?? false,
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
}

/** GET /settings — every setting, in the order of `config/settings.ts`. */
export async function listSettings() {
  const rows = await prisma.setting.findMany({
    where: { key: { in: SETTING_KEYS } },
    select: rowSelect,
  });
  const byKey = new Map(rows.map((row) => [row.key, row]));
  return SETTING_KEYS.map((key) => toView(key, byKey.get(key)));
}

/** Checks a new value against the setting's type and limits; returns its stored text. */
function validateNewValue(key: SettingKey, value: unknown): string {
  const definition: SettingDefinition = SETTINGS[key];
  const problem = (message: string) =>
    new ValidationError("Invalid value", [{ path: "body.value", message }]);

  switch (definition.type) {
    case "int": {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw problem("Must be a whole number");
      }
      if (definition.min !== undefined && value < definition.min) {
        throw problem(`Must be at least ${definition.min}`);
      }
      if (definition.max !== undefined && value > definition.max) {
        throw problem(`Must be at most ${definition.max}`);
      }
      return String(value);
    }
    case "bool":
      if (typeof value !== "boolean") throw problem("Must be true or false");
      return String(value);
    case "string":
      if (typeof value !== "string") throw problem("Must be text");
      return value;
    case "json":
      return JSON.stringify(value);
  }
}

/**
 * PATCH /settings/:key — change one setting (DEC-054). Audited in the same transaction;
 * the cache is cleared so the new value applies straight away. The same value again
 * changes nothing and writes no audit row.
 */
export async function updateSetting(admin: AuthUser, key: string, value: unknown) {
  if (!isSettingKey(key)) throw new NotFoundError("Setting not found");
  const definition: SettingDefinition = SETTINGS[key];
  if (definition.readOnly) {
    throw new AppError("This setting can't be changed", 400, "SETTING_READ_ONLY");
  }
  const newText = validateNewValue(key, value);

  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.setting.findUnique({ where: { key }, select: rowSelect });
    if (!current) {
      throw new SettingError(`Setting ${key} is missing. Run the seed (npm run db:seed).`);
    }
    if (current.value === newText) return { row: current, changed: false };

    const row = await tx.setting.update({
      where: { key },
      data: { value: newText, updatedById: admin.id },
      select: rowSelect,
    });
    await recordAudit(tx, {
      actorId: admin.id,
      action: "setting.update",
      entity: { type: "setting", id: key },
      before: { value: current.value },
      after: { value: newText },
    });
    return { row, changed: true };
  });

  if (result.changed) clearSettingsCache(key);
  return { ...toView(key, result.row), changed: result.changed };
}

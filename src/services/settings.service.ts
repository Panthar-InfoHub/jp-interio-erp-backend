import { prisma } from "../lib/prisma.js";
import { AppError } from "../utils/errors.js";
import type { SettingType } from "../generated/prisma/enums.js";
import { SETTINGS, type SettingKey, type SettingValue } from "../config/settings.js";

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

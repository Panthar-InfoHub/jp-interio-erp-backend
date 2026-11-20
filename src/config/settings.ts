import type { SettingType } from "../generated/prisma/enums.js";

/**
 * The master list of business settings (stored in the `settings` table).
 * - Code reads them with `getSetting(key)`; an unknown key is a compile error.
 * - The seed fills the table from these defaults.
 * - The Admin changes them with PATCH /api/settings/:key, inside `min`–`max` (DEC-054).
 *   `readOnly` settings can't be changed from the API.
 * - A new module adds its settings here.
 */
export interface SettingDefinition {
  type: SettingType;
  default: unknown;
  description: string;
  /** Smallest allowed value ("int" settings). */
  min?: number;
  /** Largest allowed value ("int" settings). */
  max?: number;
  /** True = shown, but can't be changed from the API. */
  readOnly?: boolean;
}

export const SETTINGS = {
  // Read-only: the apps' OTP boxes are built for this length (DEC-046).
  "otp.length": {
    type: "int",
    default: 6,
    description: "Number of digits in a login OTP.",
    readOnly: true,
  },
  "otp.expiry_minutes": {
    type: "int",
    default: 5,
    description: "Minutes an OTP stays valid.",
    min: 1,
    max: 15,
  },
  "otp.max_attempts": {
    type: "int",
    default: 5,
    description: "Wrong tries allowed before an OTP is blocked.",
    min: 3,
    max: 10,
  },
  "otp.resend_wait_seconds": {
    type: "int",
    default: 30,
    description: "Seconds before the user can ask for a new OTP.",
    min: 15,
    max: 300,
  },
  // `scan.max_per_minute` was removed (DEC-139, DEC-140): scans are never limited or tracked.
  // Its old row may still be in the database; it is hidden and never read.
  "payout.min_points": {
    type: "int",
    default: 100,
    description: "Fewest points a partner can cash out at once.",
    min: 1,
    max: 10_000,
  },
  "session.web_days": {
    type: "int",
    default: 7,
    description: "Days a web console login lasts.",
    min: 1,
    max: 30,
  },
  // 60 days (DEC-032).
  "session.app_days": {
    type: "int",
    default: 60,
    description: "Days a mobile app login lasts.",
    min: 7,
    max: 180,
  },
  // Unfinished onboardings are retired after this many days (DEC-074, DEC-093).
  "onboarding.draft_days": {
    type: "int",
    default: 30,
    description: "Days an unfinished partner onboarding is kept before it is removed.",
    min: 1,
    max: 365,
  },
  // Safety caps against typing mistakes when making a QR batch (DEC-119).
  "qr.max_batch_size": {
    type: "int",
    default: 10_000,
    description: "Most QR codes allowed in one batch.",
    min: 1,
    max: 100_000,
  },
  "qr.max_points_per_code": {
    type: "int",
    default: 1_000,
    description: "Most points one QR code can carry.",
    min: 1,
    max: 100_000,
  },
} as const satisfies Record<string, SettingDefinition>;

export type SettingKey = keyof typeof SETTINGS;

/** All setting keys, in the order above. */
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

/** True if `value` is a known setting key (e.g. from a URL). */
export function isSettingKey(value: string): value is SettingKey {
  return Object.hasOwn(SETTINGS, value);
}

type TypeOfSetting = {
  int: number;
  bool: boolean;
  string: string;
  json: unknown;
};

/** The value type `getSetting(key)` returns, e.g. number for an "int" setting. */
export type SettingValue<K extends SettingKey> = TypeOfSetting[(typeof SETTINGS)[K]["type"]];

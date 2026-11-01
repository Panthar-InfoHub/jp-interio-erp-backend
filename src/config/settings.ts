import type { SettingType } from "../generated/prisma/enums.js";

/**
 * The master list of business settings (stored in the `settings` table).
 * - Code reads them with `getSetting(key)`; an unknown key is a compile error.
 * - The seed (Task 10) fills the table from these defaults.
 * - A new module adds its settings here.
 */
export const SETTINGS = {
  "otp.length": { type: "int", default: 6, description: "Number of digits in a login OTP." },
  "otp.expiry_minutes": { type: "int", default: 5, description: "Minutes an OTP stays valid." },
  "otp.max_attempts": {
    type: "int",
    default: 5,
    description: "Wrong tries allowed before an OTP is blocked.",
  },
  "otp.resend_wait_seconds": {
    type: "int",
    default: 30,
    description: "Seconds before the user can ask for a new OTP.",
  },
  "scan.max_per_minute": {
    type: "int",
    default: 10,
    description: "Most QR scans one partner can make in a minute.",
  },
  "payout.min_points": {
    type: "int",
    default: 100,
    description: "Fewest points a partner can cash out at once.",
  },
  "session.web_days": {
    type: "int",
    default: 7,
    description: "Days a web console login lasts.",
  },
  // 60 days (DEC-032).
  "session.app_days": {
    type: "int",
    default: 60,
    description: "Days a mobile app login lasts.",
  },
} as const satisfies Record<string, { type: SettingType; default: unknown; description: string }>;

export type SettingKey = keyof typeof SETTINGS;

type TypeOfSetting = {
  int: number;
  bool: boolean;
  string: string;
  json: unknown;
};

/** The value type `getSetting(key)` returns, e.g. number for an "int" setting. */
export type SettingValue<K extends SettingKey> = TypeOfSetting[(typeof SETTINGS)[K]["type"]];

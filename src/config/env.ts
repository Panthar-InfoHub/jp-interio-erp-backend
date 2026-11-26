import "dotenv/config";
import { z } from "zod";
import { normalizePhone } from "../utils/phone.js";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).optional(),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DIRECT_URL: z.string().min(1, "DIRECT_URL is required"),
  // Dashboards and reports read through this connection (DEC-210). Empty = the main
  // database (DATABASE_URL). Set it to a Neon read-only copy later; no code change needed.
  REPORTS_DATABASE_URL: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined),

  CORS_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
    ),

  // One shared secret (DEC-036): signs access tokens and scrambles (HMAC) OTPs and
  // refresh tokens. Changing it logs everyone out. Never commit it.
  AUTH_SECRET: z.string().min(32, "must be at least 32 characters (use a long random string)"),

  // Encrypts KYC and payout numbers (PAN, Aadhaar, GST, bank account, UPI ID) in the
  // database (Module 5). 32 random bytes, base64. NEVER lose or change it: the stored
  // numbers can't be read without it. Use a different key per environment.
  KYC_ENCRYPTION_KEY: z
    .string()
    .trim()
    .refine(
      (value) => Buffer.from(value, "base64").length === 32,
      "must be 32 random bytes in base64 (see .env.example for the command)"
    ),

  // Cloudflare R2 file storage (DEC-084 – DEC-086). Apps upload straight to R2 with
  // short-lived signed links; the bucket is public and we store each file's full URL.
  R2_ACCOUNT_ID: z.string().trim().min(1, "R2_ACCOUNT_ID is required"),
  R2_ACCESS_KEY_ID: z.string().trim().min(1, "R2_ACCESS_KEY_ID is required"),
  R2_SECRET_ACCESS_KEY: z.string().trim().min(1, "R2_SECRET_ACCESS_KEY is required"),
  R2_BUCKET: z.string().trim().min(1, "R2_BUCKET is required"),
  /** The bucket's public link, e.g. https://pub-xxxx.r2.dev (no slash at the end). */
  R2_PUBLIC_BASE_URL: z
    .url("must be a full https:// link")
    .trim()
    .transform((value) => value.replace(/\/+$/, "")),
  /** Folder in front of every file name: "dev" on development machines, "prod" on the server. */
  STORAGE_PREFIX: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]+$/, "use lowercase letters, numbers or dashes, e.g. dev or prod"),

  // How login OTPs are delivered: "dummy" prints them in the terminal (development only),
  // "msg91" sends a real SMS.
  SMS_PROVIDER: z.enum(["dummy", "msg91"]).default("dummy"),

  // MSG91 Flow API (DEC-034). Required only when SMS_PROVIDER=msg91.
  MSG91_AUTH_KEY: z.string().trim().optional(),
  /** MSG91's own template ID (not the long DLT template number). */
  MSG91_OTP_TEMPLATE_ID: z.string().trim().optional(),
  /** The template variable that receives the OTP, e.g. "otp" for ##otp##. */
  MSG91_OTP_VARIABLE: z.string().trim().min(1).default("otp"),

  // Test phones (DEC-035): log in with TEST_OTP, no SMS sent. Off in production
  // unless ALLOW_TEST_PHONES_IN_PRODUCTION=true (e.g. during app-store review).
  TEST_PHONES: z
    .string()
    .default("")
    .transform((value, ctx) => {
      const phones: string[] = [];
      for (const entry of value.split(",").map((item) => item.trim())) {
        if (!entry) continue;
        const phone = normalizePhone(entry);
        if (!phone) {
          ctx.addIssue({ code: "custom", message: `"${entry}" is not a valid Indian mobile` });
          continue;
        }
        phones.push(phone);
      }
      return phones;
    }),
  TEST_OTP: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "must be exactly 6 digits")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  ALLOW_TEST_PHONES_IN_PRODUCTION: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  // Secret the hosting scheduler (Cloud Scheduler) sends as `Authorization: Bearer <it>`
  // to run the nightly jobs over HTTP (DEC-313). Empty = those endpoints are switched off.
  CRON_SECRET: z
    .string()
    .trim()
    .min(32, "must be at least 32 characters (use a long random string)")
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // The logger depends on env, so plain console is the only option here.
  console.error("❌ Invalid environment variables:\n");
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

// The dummy sender writes OTPs to the log, which must never happen in production.
if (parsed.data.NODE_ENV === "production" && parsed.data.SMS_PROVIDER === "dummy") {
  console.error("❌ SMS_PROVIDER=dummy is not allowed in production. Set SMS_PROVIDER=msg91.");
  process.exit(1);
}

if (
  parsed.data.SMS_PROVIDER === "msg91" &&
  (!parsed.data.MSG91_AUTH_KEY || !parsed.data.MSG91_OTP_TEMPLATE_ID)
) {
  console.error("❌ SMS_PROVIDER=msg91 needs MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID in .env.");
  process.exit(1);
}

if (parsed.data.TEST_PHONES.length > 0 && !parsed.data.TEST_OTP) {
  console.error("❌ TEST_PHONES is set, so TEST_OTP (6 digits) is required in .env.");
  process.exit(1);
}

export const env = parsed.data;

export const isDev = env.NODE_ENV === "development";
export const isProd = env.NODE_ENV === "production";

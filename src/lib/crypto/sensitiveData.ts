import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { env } from "../../config/env.js";
import { ValidationError } from "../../utils/errors.js";

/**
 * Protects KYC and payout numbers (Module 5, T2).
 *
 * For every sensitive number we keep three things:
 *   - the number encrypted with AES-256-GCM (unlocked only to show it to allowed users, DEC-083);
 *   - a keyed hash (HMAC-SHA256) to block duplicates without unlocking anything (DEC-074);
 *   - the last 4 characters, for short labels in lists.
 *
 * Never log these numbers (R14). The field names are in config/sensitiveFields.ts.
 */

export type SensitiveKind = "pan" | "aadhaar" | "gst" | "bank_account" | "upi";

/** What gets saved in the database for one sensitive number. */
export interface ProtectedValue {
  /** The cleaned number, e.g. "ABCDE1234F". Only to send back to an allowed user; never log. */
  normalized: string;
  encrypted: string;
  hash: string;
  last4: string;
}

// Two separate keys made from the one KYC_ENCRYPTION_KEY: one locks, one fingerprints.
const masterKey = Buffer.from(env.KYC_ENCRYPTION_KEY, "base64");
const encryptionKey = Buffer.from(hkdfSync("sha256", masterKey, "", "jp-kyc-encrypt-v1", 32));
const hashKey = Buffer.from(hkdfSync("sha256", masterKey, "", "jp-kyc-hash-v1", 32));

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

// ---- Cleaning and format checks ----

interface Rule {
  label: string;
  clean: (raw: string) => string;
  pattern: RegExp;
  hint: string;
}

const removeSpaces = (raw: string) => raw.replace(/[\s-]/g, "");

const RULES: Record<SensitiveKind | "ifsc", Rule> = {
  pan: {
    label: "PAN",
    clean: (raw) => removeSpaces(raw).toUpperCase(),
    pattern: /^[A-Z]{5}[0-9]{4}[A-Z]$/,
    hint: "10 characters, like ABCDE1234F",
  },
  aadhaar: {
    label: "Aadhaar",
    clean: removeSpaces,
    pattern: /^[2-9][0-9]{11}$/,
    hint: "12 digits, not starting with 0 or 1",
  },
  gst: {
    label: "GST number",
    clean: (raw) => removeSpaces(raw).toUpperCase(),
    pattern: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/,
    hint: "15 characters, like 27ABCDE1234F1Z5",
  },
  bank_account: {
    label: "Bank account number",
    clean: removeSpaces,
    pattern: /^[0-9]{9,18}$/,
    hint: "9 to 18 digits",
  },
  upi: {
    label: "UPI ID",
    clean: (raw) => raw.trim().toLowerCase(),
    pattern: /^[a-z0-9._-]{2,256}@[a-z]{2,64}$/,
    hint: "like name@bank",
  },
  ifsc: {
    label: "IFSC",
    clean: (raw) => removeSpaces(raw).toUpperCase(),
    pattern: /^[A-Z]{4}0[A-Z0-9]{6}$/,
    hint: "11 characters, like SBIN0001234",
  },
};

/**
 * Cleans a number (spaces removed, right letter case) and checks its format.
 * Throws a 400 naming the field, never echoing the number back.
 */
export function cleanSensitive(kind: SensitiveKind | "ifsc", raw: string): string {
  const rule = RULES[kind];
  const value = rule.clean(raw);
  if (!rule.pattern.test(value)) {
    throw new ValidationError(`${rule.label} is not valid (${rule.hint}).`);
  }
  return value;
}

/** The display label of a kind, e.g. "PAN" (used in duplicate messages, DEC-074). */
export function sensitiveLabel(kind: SensitiveKind): string {
  return RULES[kind].label;
}

// ---- Encrypt, decrypt, fingerprint ----

/** Locks a value. Output: "v1:" + base64url(iv | tag | ciphertext). A fresh random IV every time. */
export function encryptValue(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, tag, body]).toString("base64url")}`;
}

/** Unlocks a value made by `encryptValue`. Throws if it was edited or the key is wrong. */
export function decryptValue(stored: string): string {
  const [version, payload] = stored.split(":");
  if (version !== VERSION || !payload) throw new Error("Unknown encrypted value format");
  const data = Buffer.from(payload, "base64url");
  const iv = data.subarray(0, IV_BYTES);
  const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = data.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

/**
 * The fingerprint used for duplicate checks: the same cleaned number always gives the
 * same hash (64 hex characters). The kind is mixed in, so a PAN never matches a GST.
 */
export function hashValue(kind: SensitiveKind, normalized: string): string {
  return createHmac("sha256", hashKey).update(`${kind}:${normalized}`).digest("hex");
}

/**
 * Cleans, checks, encrypts, fingerprints and takes the last 4 characters, in one call.
 *
 * Bank accounts: the same account number can exist at two different banks, so the
 * fingerprint also uses the bank code (first 4 letters of the IFSC). Pass `ifsc` for them.
 */
export function protectSensitive(
  kind: SensitiveKind,
  raw: string,
  options: { ifsc?: string } = {}
): ProtectedValue {
  const normalized = cleanSensitive(kind, raw);

  let hashInput = normalized;
  if (kind === "bank_account") {
    if (!options.ifsc) throw new Error("protectSensitive: bank_account needs an IFSC");
    const bankCode = cleanSensitive("ifsc", options.ifsc).slice(0, 4);
    hashInput = `${bankCode}:${normalized}`;
  }

  return {
    normalized,
    encrypted: encryptValue(normalized),
    hash: hashValue(kind, hashInput),
    last4: normalized.slice(-4),
  };
}

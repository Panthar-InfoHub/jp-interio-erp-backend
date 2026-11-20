import { randomBytes } from "node:crypto";

/**
 * QR code helpers (Module 7, DEC-118, DEC-121).
 * - A code is 12 characters of standard Base32 (A–Z, 2–7): no 0, 1, 8 or 9, so O/0 and
 *   I/1 can't be mixed up when someone types a code by hand.
 * - Made from the operating system's secure random source: not sequential, can't be
 *   guessed, and holds no product data.
 * - The printed QR holds a link to the client's site with the code at the end.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const QR_CODE_LENGTH = 12;

/** The link printed inside every QR (DEC-118). The domain must be kept for as long as stickers are in use. */
export const QR_LINK_BASE = "https://www.jpinterio.in/q/";

/**
 * One new random code, e.g. "K7M2QX4RTB2A".
 * Each random byte is cut to 5 bits; 256 is a multiple of 32, so every character is
 * equally likely (12 × 5 = 60 bits of randomness).
 */
export function newQrCode(): string {
  const bytes = randomBytes(QR_CODE_LENGTH);
  let code = "";
  for (const byte of bytes) code += BASE32_ALPHABET[byte & 31];
  return code;
}

/** The full link printed in the QR for this code. */
export function qrLink(code: string): string {
  return `${QR_LINK_BASE}${code}`;
}

/**
 * Reads what a person typed or a scanner read: the plain code ("k7m2 qx4r tb2a") or the
 * full link ("https://www.jpinterio.in/q/K7M2QX4RTB2A"). Returns the clean 12-character
 * code, or null if it can't be one. Module 9 scanning uses this too.
 */
export function parseQrInput(input: string): string | null {
  let text = input.trim();
  const linkMarker = text.toLowerCase().lastIndexOf("/q/");
  if (linkMarker !== -1) text = text.slice(linkMarker + 3).split(/[?#/]/)[0] ?? "";
  const code = text.replace(/[\s-]/g, "").toUpperCase();
  return new RegExp(`^[A-Z2-7]{${QR_CODE_LENGTH}}$`).test(code) ? code : null;
}

/** Sites whose `/q/<CODE>` links a scan accepts (DEC-139, DEC-142). */
const SCAN_HOSTS = new Set(["jpinterio.in", "www.jpinterio.in"]);

/**
 * The strict reader used by scanning (Module 9, DEC-139, DEC-142). Accepts only:
 * - a link `http(s)://jpinterio.in/q/<CODE>` or `http(s)://www.jpinterio.in/q/<CODE>`
 *   (any case; a trailing `/`, `?…` or `#…` is ignored), or
 * - the plain 12-character code (spaces and dashes ignored, any case).
 * Returns the clean code, or null for anything else (other sites, other paths, bad codes).
 * The staff code lookup keeps the looser `parseQrInput` above.
 */
export function parseScanInput(input: string): string | null {
  const text = input.trim();
  const codePattern = new RegExp(`^[A-Z2-7]{${QR_CODE_LENGTH}}$`);

  if (!/^https?:\/\//i.test(text)) {
    // Not a link: it must be the plain code.
    if (text.includes("/") || text.includes(".")) return null;
    const code = text.replace(/[\s-]/g, "").toUpperCase();
    return codePattern.test(code) ? code : null;
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username || url.password || url.port) return null;
  if (!SCAN_HOSTS.has(url.hostname.toLowerCase())) return null;

  const match = /^\/q\/([^/]+)\/?$/i.exec(url.pathname);
  if (!match?.[1]) return null;
  const code = decodeURIComponent(match[1]).toUpperCase();
  return codePattern.test(code) ? code : null;
}

/** Batch number shown to people: `QRB-2026-0001` (DEC-120). Grows past 9999 if needed. */
export function formatBatchNo(year: number, seq: number): string {
  return `QRB-${year}-${String(seq).padStart(4, "0")}`;
}

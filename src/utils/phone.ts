/**
 * Every phone is stored as country code + number with no "+", e.g. "919876543210",
 * the format MSG91 expects (DEC-031). Only Indian mobiles for now.
 *
 *   "9876543210", "+91 98765 43210", "09876543210" → "919876543210"
 *   "12345", "5876543210" (must start with 6–9)    → null
 */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[\s\-()]/g, "").replace(/^\+/, "");
  if (!/^\d+$/.test(digits)) return null;

  let local = digits;
  if (local.length === 12 && local.startsWith("91")) local = local.slice(2);
  else if (local.length === 11 && local.startsWith("0")) local = local.slice(1);

  return /^[6-9]\d{9}$/.test(local) ? `91${local}` : null;
}

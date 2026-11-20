/**
 * Cleaned copies used for the catalog's "unique, ignoring case" rules (Module 6, DEC-111).
 * The service fills the `*_key` columns with these; the client never sends them.
 */

/** Brand and category names: trimmed, single spaces, lower case. " Green  Ply " → "green ply". */
export function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** SKU: every space removed, upper case. "bwp 18mm" → "BWP18MM". */
export function skuKey(sku: string): string {
  return sku.replace(/\s+/g, "").toUpperCase();
}

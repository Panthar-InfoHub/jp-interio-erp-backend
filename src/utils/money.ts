/**
 * Points ↔ rupees. 1 point = ₹1 (SOW). The server is the only place that turns points
 * into money (rule R4, DEC-133); the app shows the text it gets and never does money maths.
 * If the rate ever changes to a fraction, switch this to Prisma's Decimal.
 */
export const RUPEES_PER_POINT = 1;

/** Whole points → rupees as 2-decimal text, e.g. 1250 → "1250.00". */
export function pointsToRupees(points: number): string {
  return (points * RUPEES_PER_POINT).toFixed(2);
}

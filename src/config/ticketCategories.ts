import type { TicketCategory } from "../generated/prisma/enums.js";

/**
 * Support ticket categories and the names the apps show (Module 15, DEC-188, DEC-192). The
 * codes are a database list (`ticket_category`): adding one needs a migration; changing a
 * display name here does not.
 */
export const TICKET_CATEGORIES = [
  { code: "damaged_qr", label: "Damaged or unreadable QR sticker" },
  { code: "points_not_received", label: "Points not received after a scan" },
  { code: "payout_issue", label: "Payout delayed or not received" },
  { code: "account_kyc", label: "Account or KYC problem" },
  { code: "request_issue", label: "Shipment or sample request problem" },
  { code: "other", label: "Other" },
] as const satisfies readonly { code: TicketCategory; label: string }[];

export const TICKET_CATEGORY_CODES = TICKET_CATEGORIES.map((category) => category.code) as [
  TicketCategory,
  ...TicketCategory[],
];

export const ticketCategoryLabel = (code: TicketCategory) =>
  TICKET_CATEGORIES.find((category) => category.code === code)?.label ?? code;

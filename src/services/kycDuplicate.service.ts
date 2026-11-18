import type { Prisma } from "../generated/prisma/client.js";
import type { KycDocType, PayoutMethod } from "../generated/prisma/enums.js";
import { AppError } from "../utils/errors.js";

/**
 * Duplicate blocking (DEC-073, DEC-074, DEC-077, DEC-081, DEC-095).
 * A PAN, Aadhaar, GST number, bank account or UPI ID can belong to one partner only,
 * ever: rows of rejected partners, replaced documents and removed accounts all count.
 * A number is reserved the moment its step is saved, drafts included (DEC-095); a retired
 * draft's rows are deleted, which frees its numbers (DEC-093, DEC-096).
 * Phones are already unique in `users`.
 * Compared by fingerprint (hash), so nothing is unlocked to check.
 *
 * Same-second race (Module 5 T7): before checking, the transaction takes a short database
 * lock on that one number (a Postgres transaction-level advisory lock). A second request
 * for the same number waits until the first one commits, then finds the number taken.
 * The lock ends by itself when the transaction ends. Other numbers are never slowed down.
 */

/**
 * Locks one number for the rest of the transaction. The key is the number's fingerprint,
 * so the number itself never reaches the database in plain text.
 */
async function lockNumber(tx: Prisma.TransactionClient, kind: string, hash: string): Promise<void> {
  const key = `kyc-number:${kind}:${hash}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, 0))`;
}

const DOCUMENT_LABEL: Record<KycDocType, string> = {
  pan: "PAN",
  aadhaar: "Aadhaar",
  gst: "GST number",
};

const PAYOUT_LABEL: Record<PayoutMethod, string> = {
  bank: "Bank account",
  upi: "UPI ID",
};

/** 409 DUPLICATE_DOCUMENT with the message agreed in DEC-074. `details.document` names it. */
function duplicateError(label: string, document: string): AppError {
  return new AppError(
    `${label} is already registered with another account. This document cannot be registered again.`,
    409,
    "DUPLICATE_DOCUMENT",
    { document }
  );
}

/** Refuses if another partner has ever registered this PAN / Aadhaar / GST number. */
export async function assertDocumentFree(
  tx: Prisma.TransactionClient,
  docType: KycDocType,
  numberHash: string,
  partnerId: string
): Promise<void> {
  await lockNumber(tx, docType, numberHash);
  const taken = await tx.kycDocument.findFirst({
    where: { docType, numberHash, partnerId: { not: partnerId } },
    select: { id: true },
  });
  if (taken) throw duplicateError(DOCUMENT_LABEL[docType], docType);
}

/**
 * Refuses if another partner has ever registered this bank account / UPI ID, or if this
 * partner already has it as an active account (adding the same one twice).
 */
export async function assertPayoutFree(
  tx: Prisma.TransactionClient,
  method: PayoutMethod,
  valueHash: string,
  partnerId: string
): Promise<void> {
  await lockNumber(tx, method, valueHash);
  const taken = await tx.payoutAccount.findFirst({
    where: {
      method,
      valueHash,
      OR: [{ partnerId: { not: partnerId } }, { partnerId, removedAt: null }],
    },
    select: { partnerId: true },
  });
  if (!taken) return;
  if (taken.partnerId === partnerId) {
    throw new AppError(
      `This ${PAYOUT_LABEL[method].toLowerCase()} is already added to your account.`,
      409,
      "PAYOUT_ACCOUNT_EXISTS"
    );
  }
  throw duplicateError(PAYOUT_LABEL[method], method === "bank" ? "bank_account" : "upi");
}

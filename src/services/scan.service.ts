import type { Prisma } from "../generated/prisma/client.js";
import type { ScanFailReason } from "../generated/prisma/enums.js";
import { getRequestContext } from "../lib/requestContext.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { AppError } from "../utils/errors.js";
import { parseQrInput, parseScanInput } from "../utils/qrCode.js";
import type { ScanInput } from "../validators/scan.schema.js";
import { recordAudit } from "./audit.service.js";
import { postLedgerEntry } from "./ledger.service.js";
import { lockBatch } from "./qrBatch.service.js";
import { getWallet } from "./wallet.service.js";

/**
 * Scan & Earn (Module 9 T2; DEC-138 – DEC-142).
 *
 * A verified partner (checked by the route guards) sends what the camera read. In order:
 *   1. read it strictly: only a jpinterio.in `/q/` link or the plain code → else INVALID_CODE;
 *   2. find the code → else INVALID_CODE;
 *   3. in ONE transaction, with the batch row locked (same lock as "void batch"):
 *      - scanned by this partner → a retry: the original result, no new points;
 *      - scanned by someone else → ALREADY_SCANNED ("This code has already been redeemed",
 *        no date, no name: DEC-138);
 *      - voided code → VOIDED;
 *      - active → mark it scanned, save the `scans` row (zone + owning ASM copied now),
 *        post the `earn` line (points from the batch, never from the app), write the audit.
 * Switched-off products still earn (DEC-142). No rate limit, no location (DEC-138, DEC-139).
 *
 * Safety nets behind the batch lock: the unique `scans.qr_code_id` and the ledger's
 * unique (source, type) both refuse a second award of the same code.
 */

const REFUSALS: Record<ScanFailReason, { message: string; status: number; code: string }> = {
  invalid_code: {
    message: "This is not a valid JP Interio code. Please scan the QR code on the product again.",
    status: 400,
    code: "INVALID_CODE",
  },
  already_scanned: {
    message: "This code has already been redeemed.",
    status: 409,
    code: "ALREADY_SCANNED",
  },
  voided: {
    message: "This code has been cancelled and can't be used.",
    status: 409,
    code: "VOIDED",
  },
};

/** A refused scan. `reason` is saved in `scan_attempts` (T3); the message is safe to show. */
export class ScanRefusedError extends AppError {
  readonly reason: ScanFailReason;
  /** The matching QR code, if it exists (already scanned / voided). */
  readonly qrCodeId: string | null;

  constructor(reason: ScanFailReason, qrCodeId: string | null = null) {
    const { message, status, code } = REFUSALS[reason];
    super(message, status, code);
    this.reason = reason;
    this.qrCodeId = qrCodeId;
  }
}

/** Parallel scans on one batch wait for its lock, so allow a little longer than the default. */
const SCAN_TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;

/**
 * POST /api/partner/scans. Returns the scan and the wallet balance now (DEC-142).
 * A refused scan is saved in `scan_attempts` (T3) and the same error is thrown on.
 */
export async function scanCode(me: AuthUser, input: ScanInput) {
  try {
    return await tryScan(me, input);
  } catch (error) {
    if (error instanceof ScanRefusedError) await saveAttempt(me.id, input, error);
    throw error;
  }
}

/** Longest input kept in `scan_attempts.input`. */
const ATTEMPT_INPUT_MAX = 500;

/**
 * Saves one refused scan (Module 9 T3, DEC-140, DEC-144). Only reached by verified
 * partners (the route guards stop everyone else). Written on its own, after the scan
 * transaction was undone. No audit entry: this row is the record (DEC-144). Never fails
 * the request: if the save fails, it is logged and the partner still gets the refusal.
 * `db` is for checks that run inside a rolled-back transaction.
 */
export async function saveAttempt(
  partnerId: string,
  input: ScanInput,
  error: ScanRefusedError,
  db: Prisma.TransactionClient = prisma
) {
  try {
    await db.scanAttempt.create({
      data: {
        partnerId,
        input: input.code.slice(0, ATTEMPT_INPUT_MAX),
        // The code inside the input, read loosely, so fake links to other sites still show it.
        code: parseQrInput(input.code),
        qrCodeId: error.qrCodeId,
        reason: error.reason,
        deviceId: input.deviceId ?? null,
        ip: getRequestContext()?.ip?.slice(0, 45) ?? null,
      },
    });
  } catch (saveError) {
    logger.error(
      { err: saveError, partnerId, reason: error.reason },
      "Could not save scan attempt"
    );
  }
}

async function tryScan(me: AuthUser, input: ScanInput) {
  const code = parseScanInput(input.code);
  if (!code) throw new ScanRefusedError("invalid_code");

  const found = await prisma.qrCode.findUnique({
    where: { code },
    select: { id: true, batchId: true },
  });
  if (!found) throw new ScanRefusedError("invalid_code");

  const { scanId, alreadyCounted } = await prisma.$transaction(
    (tx) => awardScan(tx, me.id, found, code, input.deviceId ?? null),
    SCAN_TX_OPTIONS
  );

  const [scan, wallet] = await Promise.all([
    prisma.scan.findUniqueOrThrow({
      where: { id: scanId },
      select: {
        id: true,
        points: true,
        scannedAt: true,
        qrCode: { select: { code: true } },
        product: { select: { id: true, sku: true, name: true, imageUrl: true } },
      },
    }),
    getWallet(me.id),
  ]);

  return {
    /** True when this is a retry of a scan already counted: no new points were added. */
    alreadyCounted,
    scan: {
      id: scan.id,
      code: scan.qrCode.code,
      points: scan.points,
      scannedAt: scan.scannedAt,
      product: scan.product,
    },
    /** The wallet balance now (also on a retry, DEC-142). */
    wallet: { available: wallet.available, availableRupees: wallet.availableRupees },
  };
}

/**
 * The award itself (step 3), inside the caller's transaction. Separate so checks can run
 * it in a transaction that is rolled back. Returns the scan id and whether it was already
 * counted (a retry by the same partner).
 */
export async function awardScan(
  tx: Prisma.TransactionClient,
  partnerId: string,
  found: { id: string; batchId: string },
  code: string,
  deviceId: string | null
): Promise<{ scanId: string; alreadyCounted: boolean }> {
  // Waits here if this batch is being voided, downloaded or scanned by someone else.
  await lockBatch(tx, found.batchId);

  const qr = await tx.qrCode.findUniqueOrThrow({
    where: { id: found.id },
    select: {
      status: true,
      scannedById: true,
      productId: true,
      batch: { select: { status: true, pointsPerCode: true } },
      scan: { select: { id: true } },
    },
  });

  if (qr.status === "scanned") {
    if (qr.scannedById === partnerId && qr.scan) {
      return { scanId: qr.scan.id, alreadyCounted: true };
    }
    throw new ScanRefusedError("already_scanned", found.id);
  }
  // Voiding a batch voids its unused codes; the batch check is only a second guard.
  if (qr.status === "void" || qr.batch.status === "voided") {
    throw new ScanRefusedError("voided", found.id);
  }

  // The partner's zone and owning ASM right now, from the database (not the token).
  const partner = await tx.user.findUniqueOrThrow({
    where: { id: partnerId },
    select: { zoneId: true, parentId: true },
  });
  const now = new Date();
  const points = qr.batch.pointsPerCode;

  const marked = await tx.qrCode.updateMany({
    where: { id: found.id, status: "active" },
    data: { status: "scanned", scannedById: partnerId, scannedAt: now },
  });
  if (marked.count !== 1) {
    // Can't happen under the batch lock; refuse rather than award twice.
    logger.error({ qrCodeId: found.id }, "QR code changed under the batch lock");
    throw new ScanRefusedError("already_scanned", found.id);
  }

  const scan = await tx.scan.create({
    data: {
      qrCodeId: found.id,
      partnerId,
      productId: qr.productId,
      batchId: found.batchId,
      points,
      zoneId: partner.zoneId,
      owningAsmId: partner.parentId,
      deviceId,
      ip: getRequestContext()?.ip?.slice(0, 45) ?? null,
      scannedAt: now,
    },
    select: { id: true },
  });

  const { entry, wallet, duplicate } = await postLedgerEntry(tx, {
    type: "earn",
    partnerId,
    points,
    qrCodeId: found.id,
  });
  if (duplicate) {
    // An earn line for a code that was still active: data is out of step. Refuse.
    logger.error({ qrCodeId: found.id }, "Earn line already exists for an unscanned code");
    throw new AppError("This scan could not be completed. Please contact support.");
  }

  await recordAudit(tx, {
    actorId: partnerId,
    action: "scan.create",
    entity: { type: "scan", id: scan.id },
    before: { qrStatus: "active", available: wallet.available - points },
    after: {
      qrStatus: "scanned",
      qrCodeId: found.id,
      code,
      productId: qr.productId,
      batchId: found.batchId,
      points,
      available: wallet.available,
      ledgerEntryId: entry.id,
      deviceId,
    },
  });

  return { scanId: scan.id, alreadyCounted: false };
}

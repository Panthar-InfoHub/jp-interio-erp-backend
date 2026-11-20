import type {
  LedgerDirection,
  LedgerEntryType,
  LedgerSourceType,
  Prisma,
  RewardsLedgerEntry,
  Wallet,
} from "../generated/prisma/client.js";
import { logger } from "../lib/logger.js";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../utils/errors.js";

/**
 * The points ledger (Module 8 T2). `postLedgerEntry` is the ONLY code allowed to change
 * points (rule R3). Every move:
 *   1. locks the partner's wallet row (FOR UPDATE), so parallel moves wait in line;
 *   2. checks the wallet is not frozen and the move is allowed;
 *   3. writes one insert-only `rewards_ledger` line with the balances after it;
 *   4. updates the wallet totals,
 * all inside the CALLER's transaction: if the caller's work fails, the points move is
 * undone too. The database checks (DEC-130) are a second safety net behind these rules.
 *
 * Wallet rule (DEC-129): available = lifetime earned + net adjusted − lifetime redeemed − held.
 *
 * Not done here (DEC-131): no `audit_log` entry (each feature writes its own, in the same
 * transaction), and no permission or scope checks (the caller's job).
 */

/** Adjustment reason length (DEC-131). Same limits as the QR void reason (DEC-124). */
export const ADJUST_REASON_MIN = 10;
export const ADJUST_REASON_MAX = 500;

/** Any reason text, for the non-adjust types. */
const REASON_MAX = 500;

type CashOutType = Extract<LedgerEntryType, "hold" | "release" | "redeem" | "refund">;

/** What a caller asks for. The shape depends on the entry type. */
export type LedgerEntryInput =
  | {
      /** Points from a scan (Module 9). Made by the system. */
      type: "earn";
      partnerId: string;
      points: number;
      /** The scanned QR code's id. */
      qrCodeId: string;
    }
  | {
      /** Cash-out steps (Module 10). */
      type: CashOutType;
      partnerId: string;
      points: number;
      /** The cash-out request's id. */
      payoutId: string;
      /** Staff who did it; empty when the system did (e.g. an automatic refund). */
      actorId?: string | null;
      reason?: string | null;
    }
  | {
      /** Manual credit or debit by Admin / Rewards Sub-Admin (DEC-020, DEC-128). */
      type: "adjust";
      partnerId: string;
      points: number;
      direction: LedgerDirection;
      actorId: string;
      reason: string;
    };

export type PostLedgerResult = {
  entry: RewardsLedgerEntry;
  wallet: Wallet;
  /** True when this exact move was already saved before (a retry); nothing changed now. */
  duplicate: boolean;
};

/** Wallet moves refused because of the balance. The message is safe to show. */
export class InsufficientPointsError extends AppError {
  constructor(message: string, details: { requested: number; possible: number }) {
    super(message, 400, "INSUFFICIENT_POINTS", details);
  }
}

/** Partner not active and verified: every move is refused (DEC-129, DEC-131). */
export class WalletFrozenError extends AppError {
  constructor() {
    super(
      "This partner's wallet is frozen because the account is not active and verified. No points can move until the partner is let back in.",
      409,
      "WALLET_FROZEN"
    );
  }
}

/**
 * Is a wallet frozen? Frozen = the partner's account is not `active`, or their KYC is not
 * `verified` (DEC-129). One rule, used here and by the wallet screens (T4, T5).
 */
export function isWalletFrozen(userStatus: string, kycState: string | null | undefined): boolean {
  return userStatus !== "active" || kycState !== "verified";
}

/**
 * Locks the partner's wallet row until the transaction ends and returns it, or null if the
 * partner has no wallet. Every points move takes this lock first.
 */
export async function lockWallet(
  tx: Prisma.TransactionClient,
  partnerId: string
): Promise<Wallet | null> {
  const rows = await tx.$queryRaw<{ partner_id: string }[]>`
    SELECT partner_id FROM wallets WHERE partner_id = ${partnerId}::uuid FOR UPDATE`;
  if (rows.length === 0) return null;
  return tx.wallet.findUniqueOrThrow({ where: { partnerId } });
}

/** The ledger's own record of what a move is, worked out from the caller's input. */
type Normalised = {
  type: LedgerEntryType;
  direction: LedgerDirection;
  sourceType: LedgerSourceType;
  sourceId: string | null;
  reason: string | null;
  createdById: string | null;
};

function normalise(input: LedgerEntryInput): Normalised {
  switch (input.type) {
    case "earn":
      return {
        type: "earn",
        direction: "credit",
        sourceType: "scan",
        sourceId: input.qrCodeId,
        reason: null,
        createdById: null,
      };
    case "adjust": {
      const reason = input.reason.trim();
      if (reason.length < ADJUST_REASON_MIN || reason.length > ADJUST_REASON_MAX) {
        throw new ValidationError(
          `The reason must be ${ADJUST_REASON_MIN} to ${ADJUST_REASON_MAX} characters.`
        );
      }
      return {
        type: "adjust",
        direction: input.direction,
        sourceType: "adjustment",
        sourceId: null,
        reason,
        createdById: input.actorId,
      };
    }
    default: {
      const reason = input.reason?.trim() || null;
      if (reason && reason.length > REASON_MAX) {
        throw new ValidationError(`The reason can be at most ${REASON_MAX} characters.`);
      }
      return {
        type: input.type,
        // hold and redeem take points away; release and refund give them back.
        direction: input.type === "hold" || input.type === "redeem" ? "debit" : "credit",
        sourceType: "payout",
        sourceId: input.payoutId,
        reason,
        createdById: input.actorId ?? null,
      };
    }
  }
}

/** The wallet after the move, or a clear refusal. Pure: no database work. */
function applyMove(wallet: Wallet, move: Normalised, points: number) {
  const next = {
    available: wallet.available,
    held: wallet.held,
    lifetimeEarned: wallet.lifetimeEarned,
    lifetimeRedeemed: wallet.lifetimeRedeemed,
    netAdjusted: wallet.netAdjusted,
    scanCount: wallet.scanCount,
  };
  const refuse = (message: string, possible: number): never => {
    throw new InsufficientPointsError(message, { requested: points, possible });
  };

  switch (move.type) {
    case "earn":
      next.available += points;
      next.lifetimeEarned += points;
      next.scanCount += 1;
      break;
    case "hold":
      if (points > wallet.available) {
        refuse(`Only ${wallet.available} points are available to cash out.`, wallet.available);
      }
      next.available -= points;
      next.held += points;
      break;
    case "release":
      if (points > wallet.held) {
        refuse(`Only ${wallet.held} points are held, so ${points} can't be released.`, wallet.held);
      }
      next.held -= points;
      next.available += points;
      break;
    case "redeem":
      if (points > wallet.held) {
        refuse(`Only ${wallet.held} points are held, so ${points} can't be paid out.`, wallet.held);
      }
      next.held -= points;
      next.lifetimeRedeemed += points;
      break;
    case "refund":
      if (points > wallet.lifetimeRedeemed) {
        refuse(
          `Only ${wallet.lifetimeRedeemed} points were ever paid out, so ${points} can't be refunded.`,
          wallet.lifetimeRedeemed
        );
      }
      next.lifetimeRedeemed -= points;
      next.available += points;
      break;
    case "adjust":
      if (move.direction === "credit") {
        next.available += points;
        next.netAdjusted += points;
      } else {
        // A debit never takes available below zero; held points are never touched (DEC-128).
        if (points > wallet.available) {
          refuse(
            `Only ${wallet.available} points are available, so you can take at most ${wallet.available}.`,
            wallet.available
          );
        }
        next.available -= points;
        next.netAdjusted -= points;
      }
      break;
  }

  // Last guard, the same rule as the database check (DEC-129, DEC-130).
  const ruleHolds =
    next.available === next.lifetimeEarned + next.netAdjusted - next.lifetimeRedeemed - next.held;
  if (!ruleHolds || next.available < 0 || next.held < 0) {
    logger.error({ partnerId: wallet.partnerId, type: move.type }, "Wallet rule broken by a move");
    throw new AppError("The points could not be updated. Please try again.");
  }
  return next;
}

/**
 * Posts one points move. Must be called inside a transaction (`prisma.$transaction`).
 *
 * - Retry-safe: the same scan, or the same step of the same cash-out, returns the line
 *   already saved (`duplicate: true`) and changes nothing (DEC-131, rule R7).
 * - Refused: frozen wallet (409 WALLET_FROZEN), not enough points (400 INSUFFICIENT_POINTS),
 *   bad points or reason (400), the same source used for another partner (409).
 * - A missing wallet is a bug, not a user error: logged and refused (500), never created here.
 */
export async function postLedgerEntry(
  tx: Prisma.TransactionClient,
  input: LedgerEntryInput
): Promise<PostLedgerResult> {
  if (!Number.isSafeInteger(input.points) || input.points <= 0) {
    throw new ValidationError("Points must be a whole number above 0.");
  }
  const move = normalise(input);

  // 1. Lock the wallet first: every move for this partner now waits in line.
  const wallet = await lockWallet(tx, input.partnerId);
  if (!wallet) {
    const partner = await tx.user.findUnique({
      where: { id: input.partnerId },
      select: { id: true },
    });
    if (!partner) throw new NotFoundError("Partner not found");
    logger.error({ partnerId: input.partnerId, type: move.type }, "Partner has no wallet");
    throw new AppError("This partner's wallet could not be found. Please contact support.");
  }

  // 2. A retry of a move already saved: hand back the saved line, change nothing.
  if (move.sourceId) {
    const existing = await tx.rewardsLedgerEntry.findUnique({
      where: {
        sourceType_sourceId_type: {
          sourceType: move.sourceType,
          sourceId: move.sourceId,
          type: move.type,
        },
      },
    });
    if (existing) {
      if (existing.partnerId !== input.partnerId || existing.points !== input.points) {
        logger.warn(
          { partnerId: input.partnerId, type: move.type, sourceId: move.sourceId },
          "Ledger source already used with different details"
        );
        throw new ConflictError("These points have already been recorded differently.");
      }
      return { entry: existing, wallet, duplicate: true };
    }
  }

  // 3. Frozen wallet: no move at all, whoever asks (DEC-131). Share-lock the partner row so
  //    their status can't change under us while the move is saved.
  await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${input.partnerId}::uuid FOR SHARE`;
  const partner = await tx.user.findUniqueOrThrow({
    where: { id: input.partnerId },
    select: { status: true, partnerProfile: { select: { kycState: true } } },
  });
  if (isWalletFrozen(partner.status, partner.partnerProfile?.kycState)) {
    throw new WalletFrozenError();
  }

  // 4. Work out the new totals (refuses a move the balance can't cover).
  const next = applyMove(wallet, move, input.points);

  // 5. Write the ledger line and the wallet, in the caller's transaction.
  const entry = await tx.rewardsLedgerEntry.create({
    data: {
      partnerId: input.partnerId,
      type: move.type,
      direction: move.direction,
      points: input.points,
      availableAfter: next.available,
      heldAfter: next.held,
      sourceType: move.sourceType,
      sourceId: move.sourceId,
      reason: move.reason,
      createdById: move.createdById,
    },
  });
  const updated = await tx.wallet.update({
    where: { partnerId: input.partnerId },
    data: next,
  });

  return { entry, wallet: updated, duplicate: false };
}

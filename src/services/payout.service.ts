import type { Prisma } from "../generated/prisma/client.js";
import type { PayoutStatus, PermissionScope } from "../generated/prisma/enums.js";
import { decryptValue } from "../lib/crypto/sensitiveData.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { AppError, NotFoundError, ValidationError } from "../utils/errors.js";
import { pointsToRupees } from "../utils/money.js";
import {
  paidDetailsProblem,
  type DeclinePayoutInput,
  type EditPaidDetailsInput,
  type MarkFailedInput,
  type MarkPaidInput,
  type MyPayoutsQuery,
  type RequestPayoutInput,
  type StaffPayoutsQuery,
} from "../validators/payout.schema.js";
import { pageMeta, toPrismaOrderBy, toPrismaPaging } from "../utils/pagination.js";
import { recordAudit } from "./audit.service.js";
import { getPermissionScope } from "./permission.service.js";
import { walletForStaff } from "./wallet.service.js";
import { verifyUploadedFile } from "./storage.service.js";
import {
  isWalletFrozen,
  lockWallet,
  postLedgerEntry,
  WalletFrozenError,
} from "./ledger.service.js";
import { lockPartnerAccounts } from "./payoutAccount.service.js";
import { assertInScope, scopeForPartners } from "./scope.service.js";
import { getSetting } from "./settings.service.js";

/**
 * Payout Redemption (Module 10; DEC-045, DEC-148 – DEC-153).
 *
 * Flow: requested → approved → paid; requested / approved → declined; paid → failed.
 * Points: request = `hold`, approve = nothing, paid = `redeem`, decline = `release`,
 * failed = `refund` (DEC-150). Points move only through `postLedgerEntry`; each step writes
 * its own audit entry in the same transaction (DEC-131).
 */

/** Requests for one partner wait for the wallet lock; allow a little longer than the default. */
const PAYOUT_TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;

/** Same `Idempotency-Key` sent again with other details (DEC-153, option B). */
export class IdempotencyKeyReusedError extends AppError {
  constructor() {
    super(
      "This Idempotency-Key was already used for a different payout request. Make a new key for a new request.",
      409,
      "IDEMPOTENCY_KEY_REUSED"
    );
  }
}

// ---------------------------------------------------------------------------
// Payout numbers: PAY-<year>-<6 digits>, restarting each UTC year (DEC-150).
// ---------------------------------------------------------------------------

export function formatPayoutNo(year: number, seq: number): string {
  return `PAY-${year}-${String(seq).padStart(6, "0")}`;
}

/** The next number in this UTC year. One lock, so two payouts never share a number. */
async function nextPayoutNumber(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"payout:payout_no"}::text, 0))`;
  const year = new Date().getUTCFullYear();
  const last = await tx.payout.aggregate({ where: { year }, _max: { seq: true } });
  const seq = (last._max.seq ?? 0) + 1;
  return { year, seq, payoutNo: formatPayoutNo(year, seq) };
}

// ---------------------------------------------------------------------------
// What the partner sees
// ---------------------------------------------------------------------------

const PARTNER_PAYOUT_FIELDS = {
  id: true,
  payoutNo: true,
  points: true,
  amount: true,
  status: true,
  partnerNote: true,
  accountMethod: true,
  accountHolderName: true,
  accountValueEncrypted: true,
  accountIfsc: true,
  accountBankName: true,
  approvedAt: true,
  declinedAt: true,
  declineReason: true,
  paidAt: true,
  paidMethod: true,
  transactionId: true,
  proofUrl: true,
  failedAt: true,
  failureReason: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PayoutSelect;

type PartnerPayoutRow = Prisma.PayoutGetPayload<{ select: typeof PARTNER_PAYOUT_FIELDS }>;

/**
 * One payout for the partner's own app. The account is the copy made at request time,
 * with the full number (DEC-083, DEC-151). No staff names or ids.
 */
export function toPartnerPayout(row: PartnerPayoutRow) {
  const value = decryptValue(row.accountValueEncrypted);
  return {
    id: row.id,
    payoutNo: row.payoutNo,
    points: row.points,
    amount: row.amount.toFixed(2),
    status: row.status,
    note: row.partnerNote,
    account: {
      method: row.accountMethod,
      holderName: row.accountHolderName,
      ...(row.accountMethod === "bank"
        ? { accountNumber: value, ifsc: row.accountIfsc }
        : { upiId: value }),
      bankName: row.accountBankName,
    },
    approvedAt: row.approvedAt,
    declinedAt: row.declinedAt,
    declineReason: row.declineReason,
    paidAt: row.paidAt,
    paidMethod: row.paidMethod,
    transactionId: row.transactionId,
    // No proof link: only staff see it (DEC-155).
    failedAt: row.failedAt,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// T2: the partner asks for a payout
// ---------------------------------------------------------------------------

/**
 * POST /api/partner/payouts. The route guards already made sure the caller is a verified
 * partner with `payouts.request`. In ONE transaction:
 *   1. lock the wallet: this partner's requests (and every points move) wait in line, so
 *      the retry check below is reliable and the same points can't be held twice;
 *   2. same `Idempotency-Key` already used: same details → that payout (a retry, nothing
 *      new); other details → 409 IDEMPOTENCY_KEY_REUSED (DEC-153);
 *   3. points ≥ `payout.min_points` (no maximum, any whole number, DEC-153);
 *   4. the account is the partner's own and not removed (else 404), locked so it can't be
 *      edited meanwhile; its details and encrypted full number are copied (DEC-149, DEC-151);
 *   5. new PAY number; zone + owning ASM copied from the database now (DEC-150);
 *   6. save the payout (`requested`), post `hold` (refuses more than available with
 *      400 INSUFFICIENT_POINTS, and a frozen wallet with 409), write audit `payout.request`.
 */
export async function requestPayout(me: AuthUser, key: string, input: RequestPayoutInput) {
  const { payoutId, alreadyMade } = await prisma.$transaction(
    (tx) => createPayout(tx, me.id, key, input),
    PAYOUT_TX_OPTIONS
  );

  const [payout, wallet] = await Promise.all([
    prisma.payout.findUniqueOrThrow({ where: { id: payoutId }, select: PARTNER_PAYOUT_FIELDS }),
    prisma.wallet.findUniqueOrThrow({
      where: { partnerId: me.id },
      select: { available: true, held: true },
    }),
  ]);

  return {
    /** True when this is a retry of a request already made: nothing new was made. */
    alreadyMade,
    payout: toPartnerPayout(payout),
    /** The wallet now (also on a retry). */
    wallet: {
      available: wallet.available,
      availableRupees: pointsToRupees(wallet.available),
      held: wallet.held,
      heldRupees: pointsToRupees(wallet.held),
    },
  };
}

/**
 * The request itself, inside the caller's transaction. Separate so checks can run it in a
 * transaction that is rolled back.
 */
export async function createPayout(
  tx: Prisma.TransactionClient,
  partnerId: string,
  key: string,
  input: RequestPayoutInput
): Promise<{ payoutId: string; alreadyMade: boolean }> {
  // 1. Wallet lock first. A verified partner always has a wallet; a missing one is a bug.
  const locked = await lockWallet(tx, partnerId);
  if (!locked) {
    logger.error({ partnerId }, "Partner has no wallet");
    throw new AppError("Your wallet could not be found. Please contact support.");
  }

  // 2. Retry check, under the wallet lock.
  const existing = await tx.payout.findUnique({
    where: { partnerId_idempotencyKey: { partnerId, idempotencyKey: key } },
    select: { id: true, points: true, payoutAccountId: true, partnerNote: true },
  });
  if (existing) {
    const same =
      existing.points === input.points &&
      existing.payoutAccountId === input.payoutAccountId &&
      existing.partnerNote === input.note;
    if (!same) throw new IdempotencyKeyReusedError();
    return { payoutId: existing.id, alreadyMade: true };
  }

  // 3. Minimum (checked after the retry check, so a retry still works if it changed).
  const minPoints = await getSetting("payout.min_points");
  if (input.points < minPoints) {
    throw new ValidationError("Invalid request data", [
      { path: "body.points", message: `You can cash out at least ${minPoints} points at a time` },
    ]);
  }

  // 4. The chosen account, held still while it is copied.
  await lockPartnerAccounts(tx, partnerId);
  const account = await tx.payoutAccount.findFirst({
    where: { id: input.payoutAccountId, partnerId, removedAt: null },
    select: {
      id: true,
      method: true,
      holderName: true,
      valueEncrypted: true,
      valueLast4: true,
      ifsc: true,
      bankName: true,
    },
  });
  if (!account) throw new NotFoundError("Payout account not found");

  // 5. Number, zone and owning ASM (from the database, not the login token).
  const partner = await tx.user.findUniqueOrThrow({
    where: { id: partnerId },
    select: { zoneId: true, parentId: true },
  });
  const { year, seq, payoutNo } = await nextPayoutNumber(tx);

  // 6. Save, hold, audit.
  const payout = await tx.payout.create({
    data: {
      payoutNo,
      year,
      seq,
      partnerId,
      points: input.points,
      amount: pointsToRupees(input.points),
      partnerNote: input.note,
      payoutAccountId: account.id,
      accountMethod: account.method,
      accountHolderName: account.holderName,
      accountValueEncrypted: account.valueEncrypted,
      accountLast4: account.valueLast4,
      accountIfsc: account.ifsc,
      accountBankName: account.bankName,
      zoneId: partner.zoneId,
      owningAsmId: partner.parentId,
      idempotencyKey: key,
    },
    select: { id: true },
  });

  const { entry, wallet, duplicate } = await postLedgerEntry(tx, {
    type: "hold",
    partnerId,
    points: input.points,
    payoutId: payout.id,
  });
  if (duplicate) {
    // A hold line for a payout made just now: data is out of step. Refuse.
    logger.error({ payoutId: payout.id }, "Hold line already exists for a new payout");
    throw new AppError("This payout could not be requested. Please contact support.");
  }

  await recordAudit(tx, {
    actorId: partnerId,
    action: "payout.request",
    entity: { type: "payout", id: payout.id },
    before: { available: locked.available, held: locked.held },
    after: {
      payoutNo,
      status: "requested",
      points: input.points,
      // The account by id and type only: never its number (R14).
      payoutAccountId: account.id,
      accountMethod: account.method,
      note: input.note,
      available: wallet.available,
      held: wallet.held,
      ledgerEntryId: entry.id,
    },
  });

  return { payoutId: payout.id, alreadyMade: false };
}

// ---------------------------------------------------------------------------
// What staff see (T3; the lists in T5 use the same shape)
// ---------------------------------------------------------------------------

const PERSON = { select: { id: true, name: true } } as const;

const STAFF_PAYOUT_FIELDS = {
  ...PARTNER_PAYOUT_FIELDS,
  partner: { select: { id: true, name: true, phone: true } },
  zone: { select: { id: true, name: true } },
  owningAsm: PERSON,
  approvedBy: PERSON,
  declinedBy: PERSON,
  paidBy: PERSON,
  failedBy: PERSON,
} satisfies Prisma.PayoutSelect;

type StaffPayoutRow = Prisma.PayoutGetPayload<{ select: typeof STAFF_PAYOUT_FIELDS }>;

/**
 * One payout for staff: everything the partner sees (with the full account number,
 * DEC-083), plus the partner, the zone and owning ASM copied at request time, and who did
 * each step.
 */
export function toStaffPayout(row: StaffPayoutRow) {
  return {
    ...toPartnerPayout(row),
    proofUrl: row.proofUrl,
    partner: row.partner,
    zoneAtRequest: row.zone,
    owningAsmAtRequest: row.owningAsm,
    approvedBy: row.approvedBy,
    declinedBy: row.declinedBy,
    paidBy: row.paidBy,
    failedBy: row.failedBy,
  };
}

// ---------------------------------------------------------------------------
// T3: approve and decline (DEC-154)
// ---------------------------------------------------------------------------

/** A step that the payout's status doesn't allow (e.g. approving a declined payout). */
export class PayoutStatusError extends AppError {
  constructor(status: PayoutStatus, action: string) {
    super(`This payout is ${status}, so it can't be ${action}.`, 409, "PAYOUT_WRONG_STATUS", {
      status,
    });
  }
}

type StepResult = { payoutId: string; alreadyDone: boolean };

/**
 * Opens a staff step on one payout, inside the caller's transaction:
 *   1. the payout must belong to a partner this staff member may see (by the partner's
 *      CURRENT zone / owner, DEC-150); otherwise 404, as if it didn't exist (R2);
 *   2. lock the partner's wallet, then the payout row: the same order as a request, so
 *      steps on one partner wait in line and never deadlock;
 *   3. return the payout as it is now (after the locks).
 */
async function openStep(
  tx: Prisma.TransactionClient,
  me: AuthUser,
  scope: PermissionScope,
  payoutId: string
) {
  const found = await tx.payout.findFirst({
    where: { id: payoutId, partner: scopeForPartners(me, scope) },
    select: { id: true, partnerId: true },
  });
  const { partnerId } = assertInScope(found, { user: me, entity: "payout", id: payoutId });

  await lockWallet(tx, partnerId);
  await tx.$queryRaw`SELECT 1 FROM payouts WHERE id = ${payoutId}::uuid FOR UPDATE`;
  return tx.payout.findUniqueOrThrow({
    where: { id: payoutId },
    select: {
      id: true,
      payoutNo: true,
      partnerId: true,
      points: true,
      status: true,
      paidMethod: true,
      transactionId: true,
      proofUrl: true,
    },
  });
}

/** Refuses a step while the partner's wallet is frozen: the payout waits (DEC-149). */
async function assertNotFrozen(tx: Prisma.TransactionClient, partnerId: string) {
  await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${partnerId}::uuid FOR SHARE`;
  const partner = await tx.user.findUniqueOrThrow({
    where: { id: partnerId },
    select: { status: true, partnerProfile: { select: { kycState: true } } },
  });
  if (isWalletFrozen(partner.status, partner.partnerProfile?.kycState)) {
    throw new WalletFrozenError();
  }
}

/** Runs one staff step and returns the payout as staff see it. */
async function runStep(run: (tx: Prisma.TransactionClient) => Promise<StepResult>) {
  const { payoutId, alreadyDone } = await prisma.$transaction(run, PAYOUT_TX_OPTIONS);
  const row = await prisma.payout.findUniqueOrThrow({
    where: { id: payoutId },
    select: STAFF_PAYOUT_FIELDS,
  });
  return { alreadyDone, payout: toStaffPayout(row) };
}

/** POST /api/payouts/:id/approve — `payouts.approve` within scope. */
export function approvePayout(me: AuthUser, scope: PermissionScope, payoutId: string) {
  return runStep((tx) => approveInTx(tx, me, scope, payoutId));
}

/**
 * Approve: `requested` → `approved`. Status only: the points stay held until Paid
 * (DEC-150). Already approved → nothing changes (`alreadyDone`, DEC-154). Any other status
 * → 409. A frozen wallet refuses it (DEC-149). Audit `payout.approve`.
 */
export async function approveInTx(
  tx: Prisma.TransactionClient,
  me: AuthUser,
  scope: PermissionScope,
  payoutId: string
): Promise<StepResult> {
  const payout = await openStep(tx, me, scope, payoutId);
  if (payout.status === "approved") return { payoutId, alreadyDone: true };
  if (payout.status !== "requested") throw new PayoutStatusError(payout.status, "approved");

  await assertNotFrozen(tx, payout.partnerId);

  await tx.payout.update({
    where: { id: payoutId },
    data: { status: "approved", approvedById: me.id, approvedAt: new Date() },
  });
  await recordAudit(tx, {
    actorId: me.id,
    action: "payout.approve",
    entity: { type: "payout", id: payoutId },
    before: { status: "requested" },
    after: {
      status: "approved",
      payoutNo: payout.payoutNo,
      partnerId: payout.partnerId,
      points: payout.points,
    },
  });
  return { payoutId, alreadyDone: false };
}

/** POST /api/payouts/:id/decline — `payouts.approve` within scope. */
export function declinePayout(
  me: AuthUser,
  scope: PermissionScope,
  payoutId: string,
  input: DeclinePayoutInput
) {
  return runStep((tx) => declineInTx(tx, me, scope, payoutId, input));
}

/**
 * Decline: `requested` or `approved` → `declined`, reason required (the partner sees it).
 * The held points go back to available (`release`). Already declined → nothing changes,
 * the first reason stays (`alreadyDone`, DEC-154). Paid / failed → 409. A frozen wallet
 * refuses it (the ledger checks). Audit `payout.decline`.
 */
export async function declineInTx(
  tx: Prisma.TransactionClient,
  me: AuthUser,
  scope: PermissionScope,
  payoutId: string,
  input: DeclinePayoutInput
): Promise<StepResult> {
  const payout = await openStep(tx, me, scope, payoutId);
  if (payout.status === "declined") return { payoutId, alreadyDone: true };
  if (payout.status !== "requested" && payout.status !== "approved") {
    throw new PayoutStatusError(payout.status, "declined");
  }

  const { entry, wallet, duplicate } = await postLedgerEntry(tx, {
    type: "release",
    partnerId: payout.partnerId,
    points: payout.points,
    payoutId,
    actorId: me.id,
    reason: input.reason,
  });
  if (duplicate) {
    // A release line for a payout that wasn't declined: data is out of step. Refuse.
    logger.error({ payoutId }, "Release line already exists for an open payout");
    throw new AppError("This payout could not be declined. Please contact support.");
  }

  await tx.payout.update({
    where: { id: payoutId },
    data: {
      status: "declined",
      declinedById: me.id,
      declinedAt: new Date(),
      declineReason: input.reason,
    },
  });
  await recordAudit(tx, {
    actorId: me.id,
    action: "payout.decline",
    entity: { type: "payout", id: payoutId },
    before: { status: payout.status },
    after: {
      status: "declined",
      payoutNo: payout.payoutNo,
      partnerId: payout.partnerId,
      points: payout.points,
      reason: input.reason,
      available: wallet.available,
      held: wallet.held,
      ledgerEntryId: entry.id,
    },
  });
  return { payoutId, alreadyDone: false };
}

// ---------------------------------------------------------------------------
// T4: paid, paid-details correction, failed (DEC-155)
// ---------------------------------------------------------------------------

/** POST /api/payouts/:id/mark-paid — `payouts.mark_paid` within scope. */
export async function markPaid(
  me: AuthUser,
  scope: PermissionScope,
  payoutId: string,
  input: MarkPaidInput
) {
  // The proof is checked in R2 before the transaction (never hold locks over a network call).
  if (input.proofUrl) await verifyUploadedFile(me, "payout_proof", input.proofUrl, "proof");
  return runStep((tx) => markPaidInTx(tx, me, scope, payoutId, input));
}

/**
 * Mark paid: `approved` → `paid` (never straight from `requested`, DEC-155). Method, plus a
 * transaction ID unless cash (the validator checks), optional proof. Paid time = now.
 * The held points leave as paid out (`redeem`; lifetime redeemed goes up). Already paid →
 * nothing changes (`alreadyDone`). A frozen wallet refuses it (the ledger checks).
 * Audit `payout.mark_paid`.
 */
export async function markPaidInTx(
  tx: Prisma.TransactionClient,
  me: AuthUser,
  scope: PermissionScope,
  payoutId: string,
  input: MarkPaidInput
): Promise<StepResult> {
  const payout = await openStep(tx, me, scope, payoutId);
  if (payout.status === "paid") return { payoutId, alreadyDone: true };
  if (payout.status !== "approved") throw new PayoutStatusError(payout.status, "marked paid");

  const { entry, wallet, duplicate } = await postLedgerEntry(tx, {
    type: "redeem",
    partnerId: payout.partnerId,
    points: payout.points,
    payoutId,
    actorId: me.id,
  });
  if (duplicate) {
    logger.error({ payoutId }, "Redeem line already exists for an unpaid payout");
    throw new AppError("This payout could not be marked paid. Please contact support.");
  }

  const details = {
    paidMethod: input.method,
    transactionId: input.transactionId ?? null,
    proofUrl: input.proofUrl ?? null,
  };
  await tx.payout.update({
    where: { id: payoutId },
    data: { status: "paid", paidById: me.id, paidAt: new Date(), ...details },
  });
  await recordAudit(tx, {
    actorId: me.id,
    action: "payout.mark_paid",
    entity: { type: "payout", id: payoutId },
    before: { status: "approved" },
    after: {
      status: "paid",
      payoutNo: payout.payoutNo,
      partnerId: payout.partnerId,
      points: payout.points,
      ...details,
      held: wallet.held,
      ledgerEntryId: entry.id,
    },
  });
  return { payoutId, alreadyDone: false };
}

/** PATCH /api/payouts/:id/paid-details — `payouts.mark_paid` within scope. */
export async function editPaidDetails(
  me: AuthUser,
  scope: PermissionScope,
  payoutId: string,
  input: EditPaidDetailsInput
) {
  if (input.proofUrl) await verifyUploadedFile(me, "payout_proof", input.proofUrl, "proof");
  return runStep((tx) => editPaidDetailsInTx(tx, me, scope, payoutId, input));
}

/**
 * Correct the paid details, only while `paid` (not `failed`, DEC-155). No points move and
 * no reason is needed. Only what really changes is saved; switching to cash clears the
 * transaction ID. The result must still follow the rule (transaction ID unless cash).
 * An old proof file is kept in storage, so the audit trail can still open it.
 * Nothing changed → `alreadyDone`, no audit. Audit `payout.paid_details_edit`.
 */
export async function editPaidDetailsInTx(
  tx: Prisma.TransactionClient,
  me: AuthUser,
  scope: PermissionScope,
  payoutId: string,
  input: EditPaidDetailsInput
): Promise<StepResult> {
  const payout = await openStep(tx, me, scope, payoutId);
  if (payout.status !== "paid") {
    throw new PayoutStatusError(payout.status, "corrected (only a paid payout can be)");
  }

  const current = {
    paidMethod: payout.paidMethod!,
    transactionId: payout.transactionId,
    proofUrl: payout.proofUrl,
  };
  const method = input.method ?? current.paidMethod;
  const next = {
    paidMethod: method,
    transactionId:
      input.transactionId !== undefined
        ? input.transactionId
        : method === "cash"
          ? null
          : current.transactionId,
    proofUrl: input.proofUrl !== undefined ? input.proofUrl : current.proofUrl,
  };
  const problem = paidDetailsProblem(next.paidMethod, next.transactionId);
  if (problem) {
    throw new ValidationError("Invalid request data", [
      { path: "body.transactionId", message: problem },
    ]);
  }

  const keys = (Object.keys(next) as (keyof typeof next)[]).filter(
    (key) => next[key] !== current[key]
  );
  if (keys.length === 0) return { payoutId, alreadyDone: true };

  const before = Object.fromEntries(keys.map((key) => [key, current[key]]));
  const after = Object.fromEntries(keys.map((key) => [key, next[key]]));
  await tx.payout.update({ where: { id: payoutId }, data: after });
  await recordAudit(tx, {
    actorId: me.id,
    action: "payout.paid_details_edit",
    entity: { type: "payout", id: payoutId },
    before,
    after: { ...after, payoutNo: payout.payoutNo },
  });
  return { payoutId, alreadyDone: false };
}

/** POST /api/payouts/:id/mark-failed — `payouts.approve` within scope (DEC-149). */
export function markFailed(
  me: AuthUser,
  scope: PermissionScope,
  payoutId: string,
  input: MarkFailedInput
) {
  return runStep((tx) => markFailedInTx(tx, me, scope, payoutId, input));
}

/**
 * Mark failed: `paid` → `failed`, reason required, any time after paid, final (DEC-155).
 * The points go back to available (`refund`; lifetime redeemed goes down). Already failed →
 * nothing changes (`alreadyDone`). A frozen wallet refuses it (the ledger checks).
 * Audit `payout.mark_failed`.
 */
export async function markFailedInTx(
  tx: Prisma.TransactionClient,
  me: AuthUser,
  scope: PermissionScope,
  payoutId: string,
  input: MarkFailedInput
): Promise<StepResult> {
  const payout = await openStep(tx, me, scope, payoutId);
  if (payout.status === "failed") return { payoutId, alreadyDone: true };
  if (payout.status !== "paid") throw new PayoutStatusError(payout.status, "marked failed");

  const { entry, wallet, duplicate } = await postLedgerEntry(tx, {
    type: "refund",
    partnerId: payout.partnerId,
    points: payout.points,
    payoutId,
    actorId: me.id,
    reason: input.reason,
  });
  if (duplicate) {
    logger.error({ payoutId }, "Refund line already exists for a paid payout");
    throw new AppError("This payout could not be marked failed. Please contact support.");
  }

  await tx.payout.update({
    where: { id: payoutId },
    data: {
      status: "failed",
      failedById: me.id,
      failedAt: new Date(),
      failureReason: input.reason,
    },
  });
  await recordAudit(tx, {
    actorId: me.id,
    action: "payout.mark_failed",
    entity: { type: "payout", id: payoutId },
    before: { status: "paid" },
    after: {
      status: "failed",
      payoutNo: payout.payoutNo,
      partnerId: payout.partnerId,
      points: payout.points,
      reason: input.reason,
      available: wallet.available,
      ledgerEntryId: entry.id,
    },
  });
  return { payoutId, alreadyDone: false };
}

// ---------------------------------------------------------------------------
// T5: lists, details, Partner 360 box (DEC-156). Read-only.
// ---------------------------------------------------------------------------

/** GET /api/partner/payouts — own payouts, newest first, optional status. */
export async function listMyPayouts(
  partnerId: string,
  query: MyPayoutsQuery,
  db: Prisma.TransactionClient = prisma
) {
  const where: Prisma.PayoutWhereInput = {
    partnerId,
    ...(query.status && { status: query.status }),
  };
  const [rows, total] = await Promise.all([
    db.payout.findMany({
      where,
      orderBy: toPrismaOrderBy(query.sort),
      ...toPrismaPaging(query.page, query.limit),
      select: PARTNER_PAYOUT_FIELDS,
    }),
    db.payout.count({ where }),
  ]);
  return { items: rows.map(toPartnerPayout), meta: pageMeta(query.page, query.limit, total) };
}

/** GET /api/partner/payouts/:id — one own payout; someone else's → 404. */
export async function getMyPayout(
  partnerId: string,
  payoutId: string,
  db: Prisma.TransactionClient = prisma
) {
  const row = await db.payout.findFirst({
    where: { id: payoutId, partnerId },
    select: PARTNER_PAYOUT_FIELDS,
  });
  if (!row) throw new NotFoundError("Payout not found");
  return toPartnerPayout(row);
}

/** Payouts of partners this staff member may see (by the partner's current owner). */
function staffWhere(me: AuthUser, scope: PermissionScope): Prisma.PayoutWhereInput {
  return { partner: scopeForPartners(me, scope) };
}

/** GET /api/payouts — staff list within scope, newest first, full numbers, no totals. */
export async function listPayouts(
  me: AuthUser,
  scope: PermissionScope,
  query: StaffPayoutsQuery,
  db: Prisma.TransactionClient = prisma
) {
  const search = query.search;
  const where: Prisma.PayoutWhereInput = {
    AND: [
      staffWhere(me, scope),
      {
        ...(query.status && { status: query.status }),
        ...(query.paidMethod && { paidMethod: query.paidMethod }),
        ...(query.zoneId && { partner: { zoneId: query.zoneId } }),
        ...(query.partnerId && { partnerId: query.partnerId }),
        ...((query.from || query.to) && {
          createdAt: { ...(query.from && { gte: query.from }), ...(query.to && { lte: query.to }) },
        }),
      },
      ...(search
        ? [
            {
              OR: [
                { payoutNo: { contains: search, mode: "insensitive" as const } },
                { partner: { name: { contains: search, mode: "insensitive" as const } } },
                { partner: { phone: { contains: search } } },
                {
                  partner: {
                    partnerProfile: {
                      is: { businessName: { contains: search, mode: "insensitive" as const } },
                    },
                  },
                },
              ],
            },
          ]
        : []),
    ],
  };
  const [rows, total] = await Promise.all([
    db.payout.findMany({
      where,
      orderBy: toPrismaOrderBy(query.sort),
      ...toPrismaPaging(query.page, query.limit),
      select: STAFF_PAYOUT_FIELDS,
    }),
    db.payout.count({ where }),
  ]);
  return { items: rows.map(toStaffPayout), meta: pageMeta(query.page, query.limit, total) };
}

/** How far back "recent scans" looks on the details screen (DEC-156). */
const RECENT_SCAN_DAYS = 30;
/** How many other payouts the details screen lists (DEC-156). */
const RECENT_PAYOUTS = 5;

/**
 * GET /api/payouts/:id — one payout for staff (out of scope → 404), with partner context
 * to help decide (DEC-156): the wallet now, scans in the last 30 days, the last 5 other
 * payouts, and when the partner was verified.
 */
export async function getPayoutForStaff(
  me: AuthUser,
  scope: PermissionScope,
  payoutId: string,
  db: Prisma.TransactionClient = prisma
) {
  const row = await db.payout.findFirst({
    where: { AND: [{ id: payoutId }, staffWhere(me, scope)] },
    select: STAFF_PAYOUT_FIELDS,
  });
  const payout = assertInScope(row, { user: me, entity: "payout", id: payoutId });
  const partnerId = payout.partner.id;
  const since = new Date(Date.now() - RECENT_SCAN_DAYS * 24 * 60 * 60 * 1000);

  const [wallet, scans, others, verified] = await Promise.all([
    walletForStaff(partnerId),
    db.scan.aggregate({
      where: { partnerId, scannedAt: { gte: since } },
      _count: { _all: true },
      _sum: { points: true },
    }),
    db.payout.findMany({
      where: { partnerId, id: { not: payoutId } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: RECENT_PAYOUTS,
      select: { id: true, payoutNo: true, points: true, status: true, createdAt: true },
    }),
    db.kycReview.findFirst({
      where: { partnerId, action: "approved" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);

  return {
    ...toStaffPayout(payout),
    partnerContext: {
      wallet: wallet.wallet,
      walletNote: wallet.note,
      recentScans: {
        days: RECENT_SCAN_DAYS,
        scans: scans._count._all,
        points: scans._sum.points ?? 0,
      },
      recentPayouts: others,
      verifiedAt: verified?.createdAt ?? null,
    },
  };
}

/**
 * The payouts box in Partner 360 (DEC-156): only for staff who have `payouts.view`, with
 * the partner inside that scope; otherwise undefined (the box is left out).
 * Open = requested + approved (points still held); paid out = `paid` only (failed ones
 * were refunded).
 */
export async function payoutsBoxFor360(
  me: AuthUser,
  partnerId: string,
  db: Prisma.TransactionClient = prisma
) {
  const scope = await getPermissionScope(me, "payouts.view");
  if (!scope) return undefined;
  const inScope = await db.user.count({
    where: { AND: [{ id: partnerId }, scopeForPartners(me, scope)] },
  });
  if (inScope === 0) return undefined;

  const [open, paid, latest] = await Promise.all([
    db.payout.aggregate({
      where: { partnerId, status: { in: ["requested", "approved"] } },
      _count: { _all: true },
      _sum: { points: true },
    }),
    db.payout.aggregate({
      where: { partnerId, status: "paid" },
      _count: { _all: true },
      _sum: { points: true },
    }),
    db.payout.findFirst({
      where: { partnerId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, payoutNo: true, status: true, points: true, createdAt: true },
    }),
  ]);
  const openPoints = open._sum.points ?? 0;
  const paidPoints = paid._sum.points ?? 0;
  return {
    open: { count: open._count._all, points: openPoints, rupees: pointsToRupees(openPoints) },
    paidOut: { count: paid._count._all, points: paidPoints, rupees: pointsToRupees(paidPoints) },
    latest,
  };
}

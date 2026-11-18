import type { Prisma } from "../generated/prisma/client.js";
import type { PermissionScope } from "../generated/prisma/enums.js";
import { cleanSensitive, decryptValue, protectSensitive } from "../lib/crypto/sensitiveData.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { AppError, NotFoundError, ValidationError } from "../utils/errors.js";
import type { PayoutAccountInput } from "../validators/onboarding.schema.js";
import type { PayoutAccountEditInput } from "../validators/payoutAccount.schema.js";
import { recordAudit } from "./audit.service.js";
import { assertPayoutFree } from "./kycDuplicate.service.js";
import { createPayoutAccount } from "./onboarding.service.js";
import { assertInScope, scopeForPartners } from "./scope.service.js";

/**
 * Payout accounts after onboarding (Module 5 T10; DEC-074 – DEC-078, DEC-095, DEC-101, DEC-102).
 *
 * Who: the partner (`partner.self`, own accounts) and staff with `partners.payout_accounts`:
 * Sales Executive (assigned partners), ASM (own partners), Zonal Head (zone),
 * Partners & KYC Sub-Admin and Admin (all). Only for a VERIFIED partner (DEC-101).
 *
 * Rules:
 * - No approval; usable straight away (DEC-076). No maximum (DEC-078).
 * - At least one active account; exactly one default. Removing the default makes the
 *   oldest remaining account the default (DEC-101).
 * - Removing keeps the row (`removed_at`); its number stays blocked (DEC-073).
 * - Editing a number / UPI ID / IFSC updates the row in place, which FREES the old number
 *   (DEC-102); the new number is duplicate-checked first, under the number lock (DEC-095).
 * - Every change: one transaction, one audit row. A short per-partner lock stops two
 *   changes at once (e.g. two removals leaving zero accounts).
 */

/** Serialises changes to one partner's accounts for the rest of the transaction. */
async function lockPartnerAccounts(tx: Prisma.TransactionClient, partnerId: string): Promise<void> {
  const key = `payout-accounts:${partnerId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, 0))`;
}

/** The partner, if the actor may see them (404 otherwise) and they are verified (409). */
async function loadVerifiedPartner(actor: AuthUser, scope: PermissionScope, partnerId: string) {
  const partner = await prisma.user.findFirst({
    where: { AND: [{ id: partnerId }, scopeForPartners(actor, scope)] },
    select: { id: true, partnerProfile: { select: { kycState: true } } },
  });
  const found = assertInScope(partner, { user: actor, entity: "partner", id: partnerId });
  if (found.partnerProfile?.kycState !== "verified") {
    throw new AppError(
      "Payout accounts can be managed only after the partner is verified.",
      409,
      "PARTNER_NOT_VERIFIED"
    );
  }
}

async function loadAccount(db: Prisma.TransactionClient, partnerId: string, accountId: string) {
  const account = await db.payoutAccount.findFirst({
    where: { id: accountId, partnerId, removedAt: null },
    select: {
      id: true,
      method: true,
      holderName: true,
      valueEncrypted: true,
      valueHash: true,
      ifsc: true,
      bankName: true,
      isDefault: true,
    },
  });
  if (!account) throw new NotFoundError("Payout account not found");
  return account;
}

// ---- List ----

/** Active accounts, oldest first, with full numbers (DEC-083). */
async function listAccounts(partnerId: string) {
  const accounts = await prisma.payoutAccount.findMany({
    where: { partnerId, removedAt: null },
    select: {
      id: true,
      method: true,
      holderName: true,
      valueEncrypted: true,
      ifsc: true,
      bankName: true,
      isDefault: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return accounts.map((account) => ({
    id: account.id,
    method: account.method,
    holderName: account.holderName,
    ...(account.method === "bank"
      ? { accountNumber: decryptValue(account.valueEncrypted), ifsc: account.ifsc }
      : { upiId: decryptValue(account.valueEncrypted) }),
    bankName: account.bankName,
    isDefault: account.isDefault,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  }));
}

export async function getAccounts(actor: AuthUser, scope: PermissionScope, partnerId: string) {
  await loadVerifiedPartner(actor, scope, partnerId);
  return listAccounts(partnerId);
}

// ---- Add ----

export async function addAccount(
  actor: AuthUser,
  scope: PermissionScope,
  partnerId: string,
  input: PayoutAccountInput
) {
  await loadVerifiedPartner(actor, scope, partnerId);

  await prisma.$transaction(async (tx) => {
    await lockPartnerAccounts(tx, partnerId);
    // A verified partner always has one; this only guards odd data.
    const hasDefault = await tx.payoutAccount.count({
      where: { partnerId, removedAt: null, isDefault: true },
    });
    const saved = await createPayoutAccount(tx, actor, partnerId, input, {
      isDefault: hasDefault === 0,
    });
    await recordAudit(tx, {
      actorId: actor.id,
      action: "partner.payout_account_add",
      entity: { type: "partner", id: partnerId },
      after: {
        payoutAccountId: saved.id,
        method: input.method,
        holderName: input.holderName ?? null,
        ...(input.method === "bank"
          ? { accountNumber: saved.normalized, ifsc: saved.ifsc, bankName: input.bankName ?? null }
          : { upiId: saved.normalized }),
        isDefault: hasDefault === 0,
      },
    });
  });

  return listAccounts(partnerId);
}

// ---- Edit (DEC-101, DEC-102) ----

export async function editAccount(
  actor: AuthUser,
  scope: PermissionScope,
  partnerId: string,
  accountId: string,
  input: PayoutAccountEditInput
) {
  await loadVerifiedPartner(actor, scope, partnerId);

  await prisma.$transaction(async (tx) => {
    await lockPartnerAccounts(tx, partnerId);
    const account = await loadAccount(tx, partnerId, accountId);

    const data: Prisma.PayoutAccountUpdateInput = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const oldValue = decryptValue(account.valueEncrypted);

    if (account.method === "bank") {
      if (input.upiId !== undefined) {
        throw new ValidationError(
          "This is a bank account. To use a UPI ID, add it as a new account."
        );
      }
      if (input.holderName !== undefined) {
        if (!input.holderName) throw new ValidationError("Account holder's name is required.");
        data.holderName = input.holderName;
        before.holderName = account.holderName;
        after.holderName = input.holderName;
      }
      if (input.bankName !== undefined) {
        data.bankName = input.bankName || null;
        before.bankName = account.bankName;
        after.bankName = input.bankName || null;
      }
      if (input.accountNumber !== undefined || input.ifsc !== undefined) {
        const ifsc = input.ifsc !== undefined ? cleanSensitive("ifsc", input.ifsc) : account.ifsc;
        if (!ifsc) throw new ValidationError("IFSC is required.");
        const value = protectSensitive("bank_account", input.accountNumber ?? oldValue, { ifsc });
        if (value.hash !== account.valueHash) {
          // A different account: it must be free (the old one is freed by this update).
          await assertPayoutFree(tx, "bank", value.hash, partnerId);
        }
        data.valueEncrypted = value.encrypted;
        data.valueHash = value.hash;
        data.valueLast4 = value.last4;
        data.ifsc = ifsc;
        before.accountNumber = oldValue;
        before.ifsc = account.ifsc;
        after.accountNumber = value.normalized;
        after.ifsc = ifsc;
      }
    } else {
      if (
        input.accountNumber !== undefined ||
        input.ifsc !== undefined ||
        input.bankName !== undefined
      ) {
        throw new ValidationError(
          "This is a UPI ID. To use a bank account, add it as a new account."
        );
      }
      if (input.holderName !== undefined) {
        data.holderName = input.holderName || null;
        before.holderName = account.holderName;
        after.holderName = input.holderName || null;
      }
      if (input.upiId !== undefined) {
        const value = protectSensitive("upi", input.upiId);
        if (value.hash !== account.valueHash) {
          await assertPayoutFree(tx, "upi", value.hash, partnerId);
        }
        data.valueEncrypted = value.encrypted;
        data.valueHash = value.hash;
        data.valueLast4 = value.last4;
        before.upiId = oldValue;
        after.upiId = value.normalized;
      }
    }

    await tx.payoutAccount.update({
      where: { id: account.id },
      data: { ...data, updatedBy: { connect: { id: actor.id } } },
    });
    await recordAudit(tx, {
      actorId: actor.id,
      action: "partner.payout_account_edit",
      entity: { type: "partner", id: partnerId },
      before: { payoutAccountId: account.id, method: account.method, ...before },
      after: { payoutAccountId: account.id, method: account.method, ...after },
    });
  });

  return listAccounts(partnerId);
}

// ---- Set default ----

export async function setDefaultAccount(
  actor: AuthUser,
  scope: PermissionScope,
  partnerId: string,
  accountId: string
) {
  await loadVerifiedPartner(actor, scope, partnerId);

  await prisma.$transaction(async (tx) => {
    await lockPartnerAccounts(tx, partnerId);
    const account = await loadAccount(tx, partnerId, accountId);
    if (account.isDefault) return; // Already the default: nothing to change.

    const previous = await tx.payoutAccount.findFirst({
      where: { partnerId, removedAt: null, isDefault: true },
      select: { id: true },
    });
    await tx.payoutAccount.updateMany({
      where: { partnerId, isDefault: true },
      data: { isDefault: false },
    });
    await tx.payoutAccount.update({
      where: { id: account.id },
      data: { isDefault: true, updatedBy: { connect: { id: actor.id } } },
    });
    await recordAudit(tx, {
      actorId: actor.id,
      action: "partner.payout_account_set_default",
      entity: { type: "partner", id: partnerId },
      before: { defaultPayoutAccountId: previous?.id ?? null },
      after: { defaultPayoutAccountId: account.id },
    });
  });

  return listAccounts(partnerId);
}

// ---- Remove (DEC-076, DEC-101) ----

export async function removeAccount(
  actor: AuthUser,
  scope: PermissionScope,
  partnerId: string,
  accountId: string
) {
  await loadVerifiedPartner(actor, scope, partnerId);

  await prisma.$transaction(async (tx) => {
    await lockPartnerAccounts(tx, partnerId);
    const account = await loadAccount(tx, partnerId, accountId);

    const active = await tx.payoutAccount.count({ where: { partnerId, removedAt: null } });
    if (active <= 1) {
      throw new AppError(
        "At least one payout account is needed. Add another account before removing this one.",
        409,
        "LAST_PAYOUT_ACCOUNT"
      );
    }

    const now = new Date();
    await tx.payoutAccount.update({
      where: { id: account.id },
      data: {
        removedAt: now,
        isDefault: false,
        removedBy: { connect: { id: actor.id } },
      },
    });

    // The default was removed: the oldest remaining account takes over (DEC-101).
    let newDefaultId: string | null = null;
    if (account.isDefault) {
      const oldest = await tx.payoutAccount.findFirstOrThrow({
        where: { partnerId, removedAt: null },
        select: { id: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      await tx.payoutAccount.update({ where: { id: oldest.id }, data: { isDefault: true } });
      newDefaultId = oldest.id;
    }

    await recordAudit(tx, {
      actorId: actor.id,
      action: "partner.payout_account_remove",
      entity: { type: "partner", id: partnerId },
      before: { payoutAccountId: account.id, method: account.method, isDefault: account.isDefault },
      after: {
        payoutAccountId: account.id,
        removedAt: now,
        newDefaultPayoutAccountId: newDefaultId,
      },
    });
  });

  return listAccounts(partnerId);
}

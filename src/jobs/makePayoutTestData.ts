import { randomUUID } from "node:crypto";
import { env, isProd } from "../config/env.js";
import { ROLE } from "../config/roles.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import {
  startFieldOnboarding,
  verifyFieldOnboarding,
} from "../services/fieldOnboarding.service.js";
import { approve as approveKyc } from "../services/kyc.service.js";
import {
  approvePayout,
  declinePayout,
  markFailed,
  markPaid,
  requestPayout,
} from "../services/payout.service.js";
import { adjustPoints } from "../services/pointsAdjustment.service.js";
import { authUserByPhone, fillSignUpSteps, type TestPartner } from "./devPartnerHelpers.js";

/**
 * `npm run dev:payout-test-data` — DEV ONLY (frontend F5, DEC-252).
 *
 * Makes test payouts in every status through the SAME services the apps use:
 *   1. W 9000000213 (once): field sign-up in TEST Mumbai by TEST Mumbai ASM 1, UPI ID,
 *      KYC approved by the Admin. A partner in another zone, for the Zonal Head checks.
 *   2. Points: a points adjustment (credit) by the Admin for X, Y, E and W.
 *   3. Payouts asked for as each partner, then moved on by the Admin:
 *        X (bank)  500 Requested · 300 Approved · 250 Paid (bank transfer)
 *        Y (UPI)   200 Requested · 150 Approved · 120 Declined
 *        E (UPI)   400 Requested · 180 Failed (paid by UPI, then failed)
 *        W (UPI)   300 Requested
 *
 * Every run gives points again and adds a FRESH set (DEC-252). Leaves permanent rows
 * (points lines, payouts, audit). A partner that isn't verified and active, or has no
 * default bank / UPI account, is skipped with a note. Refuses to run when NODE_ENV=production.
 *
 * Needs: the dev test company (`npm run db:dev-data`), X / Y from `dev:kyc-test-partners`
 * (verified in the panel), and for W the first time: TEST_OTP, plus 9000000213 and
 * 9000000123 in TEST_PHONES (and the R2_* settings, for the KYC photos).
 */

const SESSION = "payout-test-data";
const MUMBAI_ASM_1 = "919000000123";
const MUMBAI_ZONE_NAME = "TEST Mumbai";
const POINTS_REASON = "TEST points for payout testing";

const W: TestPartner = {
  key: "W",
  phone: "919000000213",
  name: "TEST Partner W",
  how: "field",
  city: "Mumbai",
  pincode: "400001",
  account: { method: "upi", upiId: "testw@okaxis", holderName: "TEST Partner W" },
  pan: "TESTG7777G",
  aadhaar: "234567890143",
};

type Outcome =
  | { to: "requested" }
  | { to: "approved" }
  | { to: "paid"; method: "upi" | "bank_transfer" }
  | { to: "declined"; reason: string }
  | { to: "failed"; method: "upi" | "bank_transfer"; reason: string };

interface Plan {
  key: string;
  phone: string;
  /** Points given first (more than the payouts, so some stay available). */
  credit: number;
  payouts: { points: number; note?: string; outcome: Outcome }[];
}

const PLANS: Plan[] = [
  {
    key: "X",
    phone: "919000000210",
    credit: 1500,
    payouts: [
      { points: 500, note: "TEST: please pay to my bank account", outcome: { to: "requested" } },
      { points: 300, outcome: { to: "approved" } },
      { points: 250, outcome: { to: "paid", method: "bank_transfer" } },
    ],
  },
  {
    key: "Y",
    phone: "919000000211",
    credit: 1000,
    payouts: [
      { points: 200, outcome: { to: "requested" } },
      { points: 150, outcome: { to: "approved" } },
      {
        points: 120,
        outcome: { to: "declined", reason: "TEST: declined to check the Declined tab" },
      },
    ],
  },
  {
    key: "E",
    phone: "919000000145",
    credit: 1000,
    payouts: [
      { points: 400, outcome: { to: "requested" } },
      {
        points: 180,
        outcome: { to: "failed", method: "upi", reason: "TEST: the UPI transfer bounced back" },
      },
    ],
  },
  {
    key: "W",
    phone: W.phone,
    credit: 500,
    payouts: [{ points: 300, note: "TEST: Mumbai partner", outcome: { to: "requested" } }],
  },
];

/** The first active Admin (the Admin seeded by `npm run db:seed`). */
async function findAdmin(): Promise<AuthUser> {
  const admin = await prisma.user.findFirst({
    where: { roleId: ROLE.ADMIN, status: "active" },
    orderBy: { createdAt: "asc" },
    select: { phone: true },
  });
  if (!admin) throw new Error("No active Admin found. Run npm run db:seed.");
  return authUserByPhone(admin.phone, SESSION);
}

/**
 * W, made once: sign-up by TEST Mumbai ASM 1, then KYC approved by the Admin. An
 * unfinished or pending W from an earlier run is continued; anything else is left alone.
 */
async function ensureW(admin: AuthUser): Promise<void> {
  const existing = await prisma.user.findUnique({
    where: { phone: W.phone },
    select: { id: true, partnerProfile: { select: { kycState: true, draftRemovedAt: true } } },
  });
  const state = existing?.partnerProfile?.kycState;
  if (state === "verified") return;
  if (existing && (state === "rejected" || existing.partnerProfile?.draftRemovedAt)) {
    console.log(`SKIP  W (${W.phone}): KYC ${state ?? "removed"}, left alone (id ${existing.id})`);
    return;
  }

  let partnerId = existing?.id;
  if (!partnerId || state === "not_submitted") {
    const otp = env.TEST_OTP;
    if (!otp) throw new Error("Set TEST_OTP (6 digits) in backend/.env first (needed for W).");
    for (const phone of [W.phone, MUMBAI_ASM_1]) {
      if (!env.TEST_PHONES.includes(phone)) {
        console.log(
          `SKIP  W: add ${phone.slice(2)} to TEST_PHONES in backend/.env, then run again`
        );
        return;
      }
    }
    const zone = await prisma.zone.findFirst({
      where: { name: MUMBAI_ZONE_NAME, status: "active" },
      select: { id: true },
    });
    if (!zone) throw new Error(`Zone "${MUMBAI_ZONE_NAME}" not found. Run npm run db:dev-data.`);

    const asm = await authUserByPhone(MUMBAI_ASM_1, SESSION);
    if (!partnerId) {
      console.log("…     W: creating (field sign-up by TEST Mumbai ASM 1)");
      await startFieldOnboarding(asm, W.phone, undefined);
      partnerId = (await verifyFieldOnboarding(asm, W.phone, otp)).partnerId;
    } else {
      console.log("…     W: finishing the unfinished sign-up");
    }
    await fillSignUpSteps(asm, partnerId, W, zone.id);
  }

  // Field sign-up: the partner already has the ASM, so no ASM pick is needed.
  await approveKyc(admin, "full", partnerId, undefined);
  console.log(`DONE  W (${W.phone}): id ${partnerId}, KYC verified`);
}

/** The partner, if they can cash out now (verified, active, a default account). */
async function loadPartner(plan: Plan) {
  const user = await prisma.user.findUnique({
    where: { phone: plan.phone },
    select: { id: true, status: true, partnerProfile: { select: { kycState: true } } },
  });
  const skip = (why: string) => {
    console.log(`SKIP  ${plan.key} (${plan.phone}): ${why}`);
    return null;
  };
  if (!user) return skip("not found (run npm run dev:kyc-test-partners first)");
  if (user.partnerProfile?.kycState !== "verified") {
    return skip(`KYC ${user.partnerProfile?.kycState ?? "?"}, must be verified`);
  }
  if (user.status !== "active") return skip(`account ${user.status}, must be active`);

  const account = await prisma.payoutAccount.findFirst({
    where: { partnerId: user.id, removedAt: null, isDefault: true },
    select: { id: true },
  });
  if (!account) return skip("no default bank account or UPI ID");
  return { partnerId: user.id, accountId: account.id };
}

/** A made-up transaction ID (not unique on purpose, DEC-149). */
function testTransactionId(method: "upi" | "bank_transfer"): string {
  const digits = String(Date.now()).slice(-8);
  return method === "upi" ? `TESTUPI${digits}` : `TESTUTR${digits}`;
}

async function runPlan(plan: Plan, admin: AuthUser): Promise<number> {
  const partner = await loadPartner(plan);
  if (!partner) return 0;

  await adjustPoints(admin, "full", partner.partnerId, {
    direction: "credit",
    points: plan.credit,
    reason: POINTS_REASON,
  });
  console.log(`…     ${plan.key}: +${plan.credit} points`);

  const me = await authUserByPhone(plan.phone, SESSION);
  for (const item of plan.payouts) {
    const { payout } = await requestPayout(me, randomUUID(), {
      points: item.points,
      payoutAccountId: partner.accountId,
      note: item.note ?? null,
    });
    const { outcome } = item;

    if (outcome.to !== "requested" && outcome.to !== "declined") {
      await approvePayout(admin, "full", payout.id);
    }
    if (outcome.to === "paid" || outcome.to === "failed") {
      await markPaid(admin, "full", payout.id, {
        method: outcome.method,
        transactionId: testTransactionId(outcome.method),
      });
    }
    if (outcome.to === "declined") {
      await declinePayout(admin, "full", payout.id, { reason: outcome.reason });
    }
    if (outcome.to === "failed") {
      await markFailed(admin, "full", payout.id, { reason: outcome.reason });
    }
    console.log(`DONE  ${plan.key}: ${payout.payoutNo} ${item.points} pts → ${outcome.to}`);
  }
  return plan.payouts.length;
}

async function main() {
  if (isProd) throw new Error("This script is for the dev database only.");

  const admin = await findAdmin();
  await ensureW(admin);

  let made = 0;
  for (const plan of PLANS) made += await runPlan(plan, admin);
  console.log(`\n${made} payouts made. Open the panel → Rewards → Payouts.`);
}

try {
  await main();
} catch (error) {
  console.error(
    "Stopped:",
    error instanceof Error ? error.message : "could not connect to the database. Try again."
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

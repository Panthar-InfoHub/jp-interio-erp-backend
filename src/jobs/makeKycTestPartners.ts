import { env, isProd } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { issueOtp, verifyOtp } from "../services/auth.service.js";
import {
  startFieldOnboarding,
  verifyFieldOnboarding,
} from "../services/fieldOnboarding.service.js";
import { authUserByPhone, fillSignUpSteps, type TestPartner } from "./devPartnerHelpers.js";

/**
 * `npm run dev:kyc-test-partners` — DEV ONLY (frontend F4 T3, DEC-244).
 *
 * Creates test partners through the SAME services the apps use (every rule, duplicate
 * check and file check still applies):
 *
 *   X  9000000210  field sign-up by TEST Pune ASM 1 (has an ASM) · bank account → submitted
 *   Y  9000000211  self sign-up in the partner app (needs an ASM pick) · UPI → submitted
 *   Z  9000000212  field sign-up by ASM 1 that STOPS after the bank account (an unfinished
 *                  draft holding that number, for Number lookup / Remove draft, DEC-247)
 *
 * All: carpenter, zone TEST Pune. X and Y get real PAN / Aadhaar photos uploaded to R2
 * (small generated PNGs) and are submitted → KYC pending.
 *
 * Needs: the dev test company (`npm run db:dev-data`), TEST_OTP set, and 9000000121 in
 * TEST_PHONES; a partner whose phone is missing from TEST_PHONES is skipped with a note.
 * Leaves permanent rows (accounts, documents, audit). Running it again is safe: an
 * unfinished sign-up it could have started (X / Z by ASM 1, Y by the partner) is continued
 * from the step it stopped at; anything else with that phone (already submitted, removed,
 * started by someone else) is skipped. Refuses to run when NODE_ENV=production.
 */

const SESSION = "kyc-test-partners";
const ASM_1 = "919000000121";
const PUNE_ZONE_NAME = "TEST Pune";

// Numbers that don't clash with the backend's Module 5 test guide (P1 – P5).
const PARTNERS: TestPartner[] = [
  {
    key: "X",
    phone: "919000000210",
    name: "TEST Partner X",
    how: "field",
    city: "Pune",
    pincode: "411001",
    account: {
      method: "bank",
      holderName: "TEST Partner X",
      accountNumber: "555566667777",
      ifsc: "SBIN0004444",
      bankName: "SBI",
    },
    pan: "TESTD4444D",
    aadhaar: "234567890140",
  },
  {
    key: "Y",
    phone: "919000000211",
    name: "TEST Partner Y",
    how: "self",
    city: "Pune",
    pincode: "411001",
    account: { method: "upi", upiId: "testy@okaxis", holderName: "TEST Partner Y" },
    pan: "TESTE5555E",
    aadhaar: "234567890141",
  },
  {
    key: "Z",
    phone: "919000000212",
    name: "TEST Draft Z",
    how: "field",
    stopAfterAccount: true,
    city: "Pune",
    pincode: "411001",
    account: {
      method: "bank",
      holderName: "TEST Draft Z",
      accountNumber: "888899990000",
      ifsc: "HDFC0005555",
      bankName: "HDFC Bank",
    },
    // Not used: Z stops before the KYC step.
    pan: "TESTF6666F",
    aadhaar: "234567890142",
  },
];

/** Creates the partner's account and returns who fills in the steps. */
async function createAccount(partner: TestPartner, otp: string) {
  if (partner.how === "field") {
    const asm = await authUserByPhone(ASM_1, SESSION);
    await startFieldOnboarding(asm, partner.phone, undefined);
    const { partnerId } = await verifyFieldOnboarding(asm, partner.phone, otp);
    return { actor: asm, partnerId };
  }
  // Self sign-up: the partner logs in to the partner app; the account is created at verify.
  await issueOtp(partner.phone, "partner", undefined);
  await verifyOtp({
    phone: partner.phone,
    app: "partner",
    otp,
    deviceId: undefined,
    deviceName: "kyc-test-partners script",
    ip: undefined,
    userAgent: "kyc-test-partners script",
  });
  const self = await authUserByPhone(partner.phone, SESSION);
  return { actor: self, partnerId: self.id };
}

/**
 * A partner whose phone already exists: continue it if it is an unfinished sign-up this
 * script could have started (field: started by ASM 1; self: started by the partner);
 * otherwise leave it alone. Returns who fills in the steps, or null to skip.
 */
async function resumeExisting(
  partner: TestPartner,
  existing: { id: string; kycState: string | null; onboardedById: string | null; removed: boolean }
) {
  const skip = (why: string) => {
    console.log(`SKIP  ${partner.key} (${partner.phone}): ${why} (id ${existing.id})`);
    return null;
  };
  if (existing.removed) return skip("its unfinished sign-up was removed");
  if (existing.kycState !== "not_submitted") {
    return skip(`already submitted, KYC ${existing.kycState ?? "?"}`);
  }

  if (partner.how === "field") {
    const asm = await authUserByPhone(ASM_1, SESSION);
    if (existing.onboardedById !== asm.id) return skip("started by someone other than ASM 1");
    return { actor: asm, partnerId: existing.id };
  }
  if (existing.onboardedById !== null) return skip("started by field staff, not by the partner");
  return { actor: await authUserByPhone(partner.phone, SESSION), partnerId: existing.id };
}

async function makePartner(partner: TestPartner, zoneId: string, otp: string) {
  const existing = await prisma.user.findUnique({
    where: { phone: partner.phone },
    select: {
      id: true,
      partnerProfile: { select: { kycState: true, onboardedById: true, draftRemovedAt: true } },
    },
  });

  let who: { actor: AuthUser; partnerId: string } | null;
  if (existing) {
    who = await resumeExisting(partner, {
      id: existing.id,
      kycState: existing.partnerProfile?.kycState ?? null,
      onboardedById: existing.partnerProfile?.onboardedById ?? null,
      removed: Boolean(existing.partnerProfile?.draftRemovedAt),
    });
    if (!who) return;
    console.log(`…     ${partner.key}: finishing the unfinished sign-up`);
  } else {
    console.log(`…     ${partner.key}: creating (${partner.how} sign-up)`);
    who = await createAccount(partner, otp);
  }
  const { actor, partnerId } = who;

  // Do whatever is still left; Z stays an unfinished draft that holds its bank account number.
  const result = await fillSignUpSteps(actor, partnerId, partner, zoneId);
  if (result === "draft") {
    console.log(
      `DRAFT ${partner.key} (${partner.phone}): id ${partnerId}, left unfinished on purpose`
    );
    return;
  }

  const profile = await prisma.partnerProfile.findUniqueOrThrow({
    where: { userId: partnerId },
    select: { kycState: true },
  });
  console.log(`DONE  ${partner.key} (${partner.phone}): id ${partnerId}, KYC ${profile.kycState}`);
}

async function main() {
  if (isProd) throw new Error("This script is for the dev database only.");

  const otp = env.TEST_OTP;
  if (!otp) throw new Error("Set TEST_OTP (6 digits) in backend/.env first.");
  if (!env.TEST_PHONES.includes(ASM_1)) {
    throw new Error(`Add ${ASM_1.slice(2)} to TEST_PHONES in backend/.env, then run again.`);
  }

  const zone = await prisma.zone.findFirst({
    where: { name: PUNE_ZONE_NAME, status: "active" },
    select: { id: true },
  });
  if (!zone) throw new Error(`Zone "${PUNE_ZONE_NAME}" not found. Run npm run db:dev-data.`);

  for (const partner of PARTNERS) {
    // Its OTP only works for a test phone; skip just this partner if it isn't one.
    if (!env.TEST_PHONES.includes(partner.phone)) {
      console.log(
        `SKIP  ${partner.key} (${partner.phone}): add ${partner.phone.slice(2)} to TEST_PHONES in backend/.env, then run again`
      );
      continue;
    }
    await makePartner(partner, zone.id, otp);
  }
  console.log("\nOpen the panel → KYC review → Pending (X, Y) · Number lookup (Z's bank account).");
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

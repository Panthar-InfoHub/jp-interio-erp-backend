import { ROLE } from "../config/roles.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { KycDocType, OnboardingStep, PartnerType } from "../generated/prisma/enums.js";
import { decryptValue, protectSensitive } from "../lib/crypto/sensitiveData.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { AppError, NotFoundError, ValidationError } from "../utils/errors.js";
import type {
  BasicInfoInput,
  FirmDetailsInput,
  KycInput,
  PayoutAccountInput,
} from "../validators/onboarding.schema.js";
import { recordAudit } from "./audit.service.js";
import { assertDocumentFree, assertPayoutFree } from "./kycDuplicate.service.js";
import { verifyUploadedFile } from "./storage.service.js";

/**
 * Partner onboarding (Module 5 T4; DEC-079 – DEC-089).
 *
 *   Carpenter:     basic info → payout account → KYC → submit
 *   Dealer / OEM:  basic info → firm details → payout account → KYC → submit
 *
 * Forward only (DEC-089): a step is accepted only when it is the current step.
 * The partner type is locked once basic info is saved (DEC-088).
 *
 * Every function takes the acting user and the partner's id, so field onboarding
 * (T5: an ASM / Sales Executive filling it in) reuses the same steps.
 */

/** What the app should show next. "submit" = everything saved, ready to send. "done" = sent. */
export type NextStep =
  "basic_info" | "firm_details" | "payout_account" | "kyc_documents" | "submit" | "done";

const profileSelect = {
  userId: true,
  kycState: true,
  onboardingStep: true,
  onboardedById: true,
  partnerType: true,
  businessName: true,
  address: true,
  city: true,
  state: true,
  pincode: true,
  ownerDob: true,
  ownerAnniversaryDate: true,
  ownerSpouseName: true,
  submittedAt: true,
  rejectionReason: true,
  draftRemovedAt: true,
  user: {
    select: {
      name: true,
      email: true,
      phone: true,
      zone: { select: { id: true, name: true, code: true } },
      /** The owning ASM: set at the OTP step of field onboarding; empty for a self sign-up. */
      parent: { select: { id: true, zoneId: true } },
    },
  },
  onboardedBy: { select: { id: true, name: true, phone: true } },
} satisfies Prisma.PartnerProfileSelect;

type OnboardingProfile = Prisma.PartnerProfileGetPayload<{ select: typeof profileSelect }>;

const needsFirmDetails = (type: PartnerType | null) => type === "dealer" || type === "oem";

/** The steps this partner goes through, in order. */
function stepsFor(type: PartnerType | null): NextStep[] {
  return [
    "basic_info",
    ...(needsFirmDetails(type) ? (["firm_details"] as const) : []),
    "payout_account",
    "kyc_documents",
    "submit",
  ];
}

async function hasKycDocuments(
  db: Prisma.TransactionClient | typeof prisma,
  partnerId: string
): Promise<boolean> {
  const count = await db.kycDocument.count({
    where: { partnerId, docType: { in: ["pan", "aadhaar"] }, replacedAt: null },
  });
  return count >= 2;
}

function computeNextStep(profile: OnboardingProfile, kycSaved: boolean): NextStep {
  if (profile.kycState !== "not_submitted" || profile.onboardingStep === "submitted") return "done";
  // `partner_type` is no longer a step (DEC-087); treat it as basic info.
  if (profile.onboardingStep === "partner_type") return "basic_info";
  if (profile.onboardingStep === "kyc_documents" && kycSaved) return "submit";
  return profile.onboardingStep;
}

async function loadProfile(partnerId: string): Promise<OnboardingProfile> {
  const profile = await prisma.partnerProfile.findUnique({
    where: { userId: partnerId },
    select: profileSelect,
  });
  if (!profile) throw new NotFoundError("Partner not found");
  return profile;
}

/**
 * Who may fill in this onboarding, while it is not yet submitted:
 * - the partner themself, including finishing a draft field staff started (DEC-091);
 * - the ASM / Sales Executive who started it (T5).
 * Both may save the current step; forward-only steps stop clashes (DEC-091).
 */
async function loadForEditing(actor: AuthUser, partnerId: string): Promise<OnboardingProfile> {
  const profile = await loadProfile(partnerId);
  // Retired by the clean-up (DEC-093): treated as gone.
  if (profile.draftRemovedAt) throw new NotFoundError("Partner not found");

  if (actor.roleId === ROLE.PARTNER) {
    if (actor.id !== partnerId) throw new NotFoundError("Partner not found");
  } else if (profile.onboardedById !== actor.id) {
    throw new NotFoundError("Partner not found");
  }

  if (profile.kycState !== "not_submitted" || profile.onboardingStep === "submitted") {
    throw new AppError(
      "These details are already submitted and cannot be changed here.",
      409,
      "ONBOARDING_CLOSED"
    );
  }
  return profile;
}

function wrongStep(next: NextStep): AppError {
  return new AppError(
    `This step is already done or not open yet. Please continue from: ${next.replace("_", " ")}.`,
    409,
    "WRONG_ONBOARDING_STEP",
    { nextStep: next }
  );
}

/** Forward only (DEC-089): refuses any step other than the current one. */
async function expectStep(profile: OnboardingProfile, step: NextStep): Promise<void> {
  const next = computeNextStep(profile, await hasKycDocuments(prisma, profile.userId));
  if (next !== step) throw wrongStep(next);
}

/**
 * Moves the step forward only if it is still the expected one (a second, simultaneous
 * request finds nothing to update and is refused).
 */
async function advanceStep(
  tx: Prisma.TransactionClient,
  partnerId: string,
  from: OnboardingStep[],
  data: Prisma.PartnerProfileUpdateManyMutationInput
): Promise<void> {
  const { count } = await tx.partnerProfile.updateMany({
    where: { userId: partnerId, kycState: "not_submitted", onboardingStep: { in: from } },
    data,
  });
  if (count === 0) {
    throw new AppError(
      "This step was already saved. Please refresh.",
      409,
      "WRONG_ONBOARDING_STEP"
    );
  }
}

const isoDate = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);

/** Unlocks a stored number to show it (DEC-083: allowed users see full numbers). */
function reveal(encrypted: string): string {
  return decryptValue(encrypted);
}

// ---- Read ----

/** Active zones to pick on the basic info page (DEC-074: partners see a read-only list). */
export async function listZonesForSignUp() {
  return prisma.zone.findMany({
    where: { status: "active" },
    select: { id: true, name: true, code: true, state: true },
    orderBy: { name: "asc" },
  });
}

/** "Where am I?": everything saved so far and the step to show next. */
export async function getOnboarding(partnerId: string) {
  const profile = await loadProfile(partnerId);
  const [documents, payoutAccounts] = await Promise.all([
    prisma.kycDocument.findMany({
      where: { partnerId, replacedAt: null },
      select: { docType: true, numberEncrypted: true, fileUrl: true },
    }),
    prisma.payoutAccount.findMany({
      where: { partnerId, removedAt: null },
      select: {
        id: true,
        method: true,
        holderName: true,
        valueEncrypted: true,
        ifsc: true,
        bankName: true,
        isDefault: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const document = (type: KycDocType) => {
    const found = documents.find((doc) => doc.docType === type);
    return found ? { number: reveal(found.numberEncrypted), fileUrl: found.fileUrl } : null;
  };
  const kycSaved = Boolean(document("pan") && document("aadhaar"));
  const gst = document("gst");
  const basicSaved =
    profile.onboardingStep !== "basic_info" || profile.kycState !== "not_submitted";

  return {
    kycState: profile.kycState,
    nextStep: computeNextStep(profile, kycSaved),
    steps: stepsFor(profile.partnerType),
    /** Set when an ASM / Sales Executive started this onboarding; only they can finish it. */
    setUpBy: profile.onboardedBy
      ? { name: profile.onboardedBy.name, phone: profile.onboardedBy.phone }
      : null,
    basicInfo: basicSaved
      ? {
          name: profile.user.name,
          email: profile.user.email,
          phone: profile.user.phone,
          address: profile.address,
          city: profile.city,
          state: profile.state,
          pincode: profile.pincode,
          zone: profile.user.zone,
          partnerType: profile.partnerType,
          businessName: profile.businessName,
        }
      : null,
    firmDetails: gst
      ? {
          firmName: profile.businessName,
          gstNumber: gst.number,
          gstCertificateUrl: gst.fileUrl,
          ownerDob: isoDate(profile.ownerDob),
          ownerAnniversaryDate: isoDate(profile.ownerAnniversaryDate),
          ownerSpouseName: profile.ownerSpouseName,
        }
      : null,
    payoutAccounts: payoutAccounts.map((account) => ({
      id: account.id,
      method: account.method,
      holderName: account.holderName,
      ...(account.method === "bank"
        ? { accountNumber: reveal(account.valueEncrypted), ifsc: account.ifsc }
        : { upiId: reveal(account.valueEncrypted) }),
      bankName: account.bankName,
      isDefault: account.isDefault,
    })),
    kycDocuments: { pan: document("pan"), aadhaar: document("aadhaar") },
    submittedAt: profile.submittedAt,
    rejectionReason: profile.rejectionReason,
  };
}

// ---- Step 1: basic info (DEC-087, DEC-088) ----

export async function saveBasicInfo(actor: AuthUser, partnerId: string, input: BasicInfoInput) {
  const profile = await loadForEditing(actor, partnerId);
  await expectStep(profile, "basic_info");

  const zone = await prisma.zone.findUnique({
    where: { id: input.zoneId },
    select: { id: true, status: true },
  });
  if (!zone || zone.status !== "active") {
    throw new ValidationError("Invalid request data", [
      { path: "body.zoneId", message: "Pick a zone from the list" },
    ]);
  }
  // Field onboarding: the owning ASM is already set, so the zone must be theirs (DEC-092).
  const owner = profile.user.parent;
  if (owner && owner.zoneId !== input.zoneId) {
    throw new AppError(
      actor.roleId === ROLE.PARTNER
        ? "Please pick the zone of the field staff who started your sign-up."
        : "The zone you picked does not fall under your jurisdiction.",
      403,
      "ZONE_NOT_ALLOWED"
    );
  }

  const next: OnboardingStep = needsFirmDetails(input.partnerType)
    ? "firm_details"
    : "payout_account";

  await prisma.$transaction(async (tx) => {
    await advanceStep(tx, partnerId, ["basic_info", "partner_type"], {
      partnerType: input.partnerType,
      businessName: input.businessName ?? null,
      address: input.address,
      city: input.city,
      state: input.state,
      pincode: input.pincode,
      onboardingStep: next,
    });
    // Zone: the Zonal Head of this zone reviews the request (DEC-073).
    await tx.user.update({
      where: { id: partnerId },
      data: { name: input.name, email: input.email ?? null, zoneId: input.zoneId },
    });
    await recordAudit(tx, {
      actorId: actor.id,
      action: "partner.onboarding_basic_info",
      entity: { type: "partner", id: partnerId },
      after: { ...input, onboardingStep: next },
    });
  });

  return getOnboarding(partnerId);
}

// ---- Step 2: firm details, dealer / OEM only (DEC-079 – DEC-081) ----

export async function saveFirmDetails(actor: AuthUser, partnerId: string, input: FirmDetailsInput) {
  const profile = await loadForEditing(actor, partnerId);
  await expectStep(profile, "firm_details");

  const gst = protectSensitive("gst", input.gstNumber);
  const file = await verifyUploadedFile(actor, "kyc", input.gstCertificateUrl, "GST certificate");

  await prisma.$transaction(async (tx) => {
    await assertDocumentFree(tx, "gst", gst.hash, partnerId);
    await advanceStep(tx, partnerId, ["firm_details"], {
      businessName: input.firmName,
      ownerDob: input.ownerDob ?? null,
      ownerAnniversaryDate: input.ownerAnniversaryDate ?? null,
      ownerSpouseName: input.ownerSpouseName ?? null,
      onboardingStep: "payout_account",
    });
    await createKycDocument(tx, actor, partnerId, "gst", gst, file);
    await recordAudit(tx, {
      actorId: actor.id,
      action: "partner.onboarding_firm_details",
      entity: { type: "partner", id: partnerId },
      after: {
        firmName: input.firmName,
        gstNumber: gst.normalized,
        gstCertificateUrl: file.fileUrl,
        ownerDob: input.ownerDob ?? null,
        ownerAnniversaryDate: input.ownerAnniversaryDate ?? null,
        ownerSpouseName: input.ownerSpouseName ?? null,
        onboardingStep: "payout_account",
      },
    });
  });

  return getOnboarding(partnerId);
}

/** Saves one KYC document; an older one of the same type is kept, marked replaced. */
async function createKycDocument(
  tx: Prisma.TransactionClient,
  actor: AuthUser,
  partnerId: string,
  docType: KycDocType,
  value: { encrypted: string; hash: string; last4: string },
  file: { fileUrl: string; contentType: string; sizeBytes: number }
) {
  await tx.kycDocument.updateMany({
    where: { partnerId, docType, replacedAt: null },
    data: { replacedAt: new Date() },
  });
  return tx.kycDocument.create({
    data: {
      partnerId,
      docType,
      numberEncrypted: value.encrypted,
      numberHash: value.hash,
      numberLast4: value.last4,
      fileUrl: file.fileUrl,
      fileMimeType: file.contentType,
      fileSizeBytes: file.sizeBytes,
      uploadedById: actor.id,
    },
    select: { id: true },
  });
}

// ---- Step 3: payout account (DEC-074, DEC-076) ----

/**
 * Cleans, encrypts and duplicate-checks one bank account / UPI ID, then saves it.
 * Also used later for adding accounts from the profile (T10).
 */
export async function createPayoutAccount(
  tx: Prisma.TransactionClient,
  actor: AuthUser,
  partnerId: string,
  input: PayoutAccountInput,
  options: { isDefault: boolean }
) {
  const value =
    input.method === "bank"
      ? protectSensitive("bank_account", input.accountNumber, { ifsc: input.ifsc })
      : protectSensitive("upi", input.upiId);
  const ifsc = input.method === "bank" ? input.ifsc.replace(/\s/g, "").toUpperCase() : null;

  await assertPayoutFree(tx, input.method, value.hash, partnerId);

  const account = await tx.payoutAccount.create({
    data: {
      partnerId,
      method: input.method,
      holderName: input.holderName ?? null,
      valueEncrypted: value.encrypted,
      valueHash: value.hash,
      valueLast4: value.last4,
      ifsc,
      bankName: input.method === "bank" ? (input.bankName ?? null) : null,
      isDefault: options.isDefault,
      addedById: actor.id,
    },
    select: { id: true },
  });

  return { id: account.id, normalized: value.normalized, ifsc };
}

export async function savePayoutAccount(
  actor: AuthUser,
  partnerId: string,
  input: PayoutAccountInput
) {
  const profile = await loadForEditing(actor, partnerId);
  await expectStep(profile, "payout_account");

  await prisma.$transaction(async (tx) => {
    await advanceStep(tx, partnerId, ["payout_account"], { onboardingStep: "kyc_documents" });
    // The first account is the default (DEC-076).
    const saved = await createPayoutAccount(tx, actor, partnerId, input, { isDefault: true });
    await recordAudit(tx, {
      actorId: actor.id,
      action: "partner.onboarding_payout_account",
      entity: { type: "partner", id: partnerId },
      after: {
        payoutAccountId: saved.id,
        method: input.method,
        holderName: input.holderName ?? null,
        ...(input.method === "bank"
          ? { accountNumber: saved.normalized, ifsc: saved.ifsc, bankName: input.bankName ?? null }
          : { upiId: saved.normalized }),
        isDefault: true,
        onboardingStep: "kyc_documents",
      },
    });
  });

  return getOnboarding(partnerId);
}

// ---- Step 4: KYC documents (DEC-081, DEC-082) ----

export async function saveKyc(actor: AuthUser, partnerId: string, input: KycInput) {
  const profile = await loadForEditing(actor, partnerId);
  await expectStep(profile, "kyc_documents");

  const pan = protectSensitive("pan", input.panNumber);
  const aadhaar = protectSensitive("aadhaar", input.aadhaarNumber);
  if (input.panPhotoUrl === input.aadhaarPhotoUrl) {
    throw new ValidationError("The PAN photo and the Aadhaar photo must be two different files.");
  }
  const [panFile, aadhaarFile] = await Promise.all([
    verifyUploadedFile(actor, "kyc", input.panPhotoUrl, "PAN photo"),
    verifyUploadedFile(actor, "kyc", input.aadhaarPhotoUrl, "Aadhaar photo"),
  ]);

  await prisma.$transaction(async (tx) => {
    // Forward only: a second save (e.g. a double tap) finds the documents already there.
    await advanceStep(tx, partnerId, ["kyc_documents"], { updatedAt: new Date() });
    if (await hasKycDocuments(tx, partnerId)) throw wrongStep("submit");

    await assertDocumentFree(tx, "pan", pan.hash, partnerId);
    await assertDocumentFree(tx, "aadhaar", aadhaar.hash, partnerId);
    await createKycDocument(tx, actor, partnerId, "pan", pan, panFile);
    await createKycDocument(tx, actor, partnerId, "aadhaar", aadhaar, aadhaarFile);
    await recordAudit(tx, {
      actorId: actor.id,
      action: "partner.onboarding_kyc",
      entity: { type: "partner", id: partnerId },
      after: {
        panNumber: pan.normalized,
        panPhotoUrl: panFile.fileUrl,
        aadhaarNumber: aadhaar.normalized,
        aadhaarPhotoUrl: aadhaarFile.fileUrl,
      },
    });
  });

  return getOnboarding(partnerId);
}

// ---- Step 5: submit for approval (DEC-073, DEC-074) ----

export async function submitOnboarding(actor: AuthUser, partnerId: string) {
  const profile = await loadForEditing(actor, partnerId);
  await expectStep(profile, "submit");

  // A last check that everything required is there (the steps already enforce it).
  const missing: string[] = [];
  if (!profile.user.name || !profile.address || !profile.user.zone || !profile.partnerType) {
    missing.push("basic info");
  }
  const [gstCount, payoutCount] = await Promise.all([
    prisma.kycDocument.count({ where: { partnerId, docType: "gst", replacedAt: null } }),
    prisma.payoutAccount.count({ where: { partnerId, removedAt: null } }),
  ]);
  if (needsFirmDetails(profile.partnerType) && (gstCount === 0 || !profile.businessName)) {
    missing.push("firm details");
  }
  if (payoutCount === 0) missing.push("payout account");
  if (missing.length > 0) {
    throw new ValidationError(`Please complete: ${missing.join(", ")}.`);
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await advanceStep(tx, partnerId, ["kyc_documents"], {
      kycState: "pending",
      onboardingStep: "submitted",
      submittedAt: now,
      rejectionReason: null,
    });
    await tx.kycReview.create({
      data: { partnerId, action: "submitted", actorId: actor.id },
    });
    await recordAudit(tx, {
      actorId: actor.id,
      action: "partner.onboarding_submit",
      entity: { type: "partner", id: partnerId },
      before: { kycState: "not_submitted" },
      after: { kycState: "pending", submittedAt: now, zoneId: profile.user.zone?.id },
    });
  });

  return getOnboarding(partnerId);
}

import { ROLE } from "../config/roles.js";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { AppError, ForbiddenError, NotFoundError } from "../utils/errors.js";
import { recordAudit } from "./audit.service.js";
import { checkOtp, issueOtp, useOtp } from "./auth.service.js";
import { getOnboarding } from "./onboarding.service.js";
import { getSetting } from "./settings.service.js";

/**
 * Field onboarding by an ASM or Sales Executive (Module 5 T5; DEC-074, DEC-090 – DEC-092).
 *
 * 1. `start`: an OTP goes to the new partner's phone; the partner tells it to the staff member.
 * 2. `verify`: the partner's account is created, owned automatically:
 *      started by an ASM            → owner = that ASM, no Sales Executive;
 *      started by a Sales Executive → owner = their ASM, Sales Executive = them.
 * 3. The steps are the same as self sign-up (onboarding.service.ts, with the partner's id).
 *
 * The OTP rows use app "field" with the PARTNER's phone, so they never mix with the
 * partner's own Partner App login OTPs. Same rules as login (DEC-090).
 */

const OTP_APP = "field" as const;

/** The ASM who will own partners this staff member onboards. */
async function owningAsm(actor: AuthUser): Promise<{ id: string; zoneId: string | null }> {
  if (actor.roleId === ROLE.ASM) return { id: actor.id, zoneId: actor.zoneId };
  if (actor.roleId === ROLE.SALES_EXECUTIVE && actor.parentId) {
    const asm = await prisma.user.findUnique({
      where: { id: actor.parentId },
      select: { id: true, zoneId: true, roleId: true, status: true },
    });
    if (asm && asm.roleId === ROLE.ASM && asm.status === "active") {
      return { id: asm.id, zoneId: asm.zoneId };
    }
  }
  throw new ForbiddenError("You need an active ASM above you to onboard partners.");
}

function phoneTaken(): AppError {
  return new AppError("This phone number is already registered.", 409, "PHONE_ALREADY_REGISTERED");
}

async function assertPhoneFree(phone: string): Promise<void> {
  const taken = await prisma.user.findUnique({ where: { phone }, select: { id: true } });
  if (taken) throw phoneTaken();
}

/** True for the database's "phone already exists" error (two creates in the same second). */
function isPhoneUniqueError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  return JSON.stringify(error.meta ?? {}).includes("phone");
}

/** Step A: sends an OTP to the new partner's phone. */
export async function startFieldOnboarding(actor: AuthUser, phone: string, ip: string | undefined) {
  await owningAsm(actor);
  await assertPhoneFree(phone);
  return issueOtp(phone, OTP_APP, ip);
}

/** Step B: checks the OTP and creates the partner's account (DEC-074). */
export async function verifyFieldOnboarding(actor: AuthUser, phone: string, code: string) {
  const asm = await owningAsm(actor);
  await assertPhoneFree(phone);
  const otp = await checkOtp(phone, OTP_APP, code);

  // The check above can pass for two staff at the same second; the database's unique
  // phone rule then stops the second one, which gets the same clear message (Module 5 T7).
  const partnerId = await createFieldPartner(actor, asm, phone, otp).catch((error: unknown) => {
    throw isPhoneUniqueError(error) ? phoneTaken() : error;
  });

  return { partnerId, onboarding: await getOnboarding(partnerId) };
}

function createFieldPartner(
  actor: AuthUser,
  asm: { id: string; zoneId: string | null },
  phone: string,
  otp: Awaited<ReturnType<typeof checkOtp>>
): Promise<string> {
  return prisma.$transaction(async (tx) => {
    await useOtp(tx, otp);

    const created = await tx.user.create({
      data: {
        phone,
        roleId: ROLE.PARTNER,
        parentId: asm.id,
        // The zone is confirmed on the basic info page; it must be the ASM's (DEC-092).
        zoneId: asm.zoneId,
        partnerProfile: {
          create: {
            onboardedById: actor.id,
            salesExecutiveId: actor.roleId === ROLE.SALES_EXECUTIVE ? actor.id : null,
          },
        },
      },
      select: { id: true, status: true },
    });

    await recordAudit(tx, {
      actorId: actor.id,
      action: "user.create",
      entity: { type: "user", id: created.id },
      after: {
        phone,
        roleId: ROLE.PARTNER,
        status: created.status,
        via: "field_onboarding",
        asmId: asm.id,
        salesExecutiveId: actor.roleId === ROLE.SALES_EXECUTIVE ? actor.id : null,
      },
    });
    return created.id;
  });
}

/** "My unfinished onboardings": drafts this staff member started (DEC-074). */
export async function listMyDrafts(actor: AuthUser) {
  const drafts = await prisma.partnerProfile.findMany({
    where: {
      onboardedById: actor.id,
      kycState: "not_submitted",
      onboardingStep: { not: "submitted" },
      // Retired by the clean-up (DEC-093): gone from the list.
      draftRemovedAt: null,
    },
    select: {
      userId: true,
      partnerType: true,
      businessName: true,
      onboardingStep: true,
      onboardingStartedAt: true,
      user: { select: { name: true, phone: true } },
    },
    orderBy: { onboardingStartedAt: "desc" },
  });

  const days = await getSetting("onboarding.draft_days");
  return drafts.map((draft) => ({
    partnerId: draft.userId,
    name: draft.user.name,
    phone: draft.user.phone,
    partnerType: draft.partnerType,
    businessName: draft.businessName,
    // `partner_type` is no longer a step (DEC-087).
    currentStep: draft.onboardingStep === "partner_type" ? "basic_info" : draft.onboardingStep,
    startedAt: draft.onboardingStartedAt,
    removedAfter: new Date(draft.onboardingStartedAt.getTime() + days * 24 * 60 * 60 * 1000),
  }));
}

/** One onboarding this staff member started (also after it is submitted, to see its state). */
export async function getMyOnboarding(actor: AuthUser, partnerId: string) {
  const profile = await prisma.partnerProfile.findUnique({
    where: { userId: partnerId },
    select: { onboardedById: true, draftRemovedAt: true },
  });
  if (!profile || profile.onboardedById !== actor.id || profile.draftRemovedAt) {
    throw new NotFoundError("Partner not found");
  }
  return getOnboarding(partnerId);
}

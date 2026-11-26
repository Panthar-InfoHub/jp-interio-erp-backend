import QRCode from "qrcode";
import { ROLES } from "../config/roles.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import {
  getOnboarding,
  saveBasicInfo,
  saveKyc,
  savePayoutAccount,
  submitOnboarding,
} from "../services/onboarding.service.js";
import { createUploadLink } from "../services/storage.service.js";
import {
  basicInfoSchemas,
  kycSchemas,
  payoutAccountBody,
} from "../validators/onboarding.schema.js";

/**
 * Shared pieces of the DEV-ONLY test-data scripts (`dev:kyc-test-partners`,
 * `dev:payout-test-data`, `dev:request-test-data`, `dev:task-test-data`,
 * `dev:ticket-test-data`). Everything goes
 * through the same services the apps use.
 */

/** A test partner the scripts sign up (carpenter, one bank account or UPI ID). */
export interface TestPartner {
  key: string;
  /** Leave the sign-up unfinished after the bank / UPI account (a draft holding that number). */
  stopAfterAccount?: boolean;
  phone: string;
  name: string;
  how: "field" | "self";
  city: string;
  pincode: string;
  account:
    | { method: "bank"; holderName: string; accountNumber: string; ifsc: string; bankName: string }
    | { method: "upi"; upiId: string; holderName: string };
  pan: string;
  aadhaar: string;
}

/** The same user object `requireAuth` builds, read from the database. */
export async function authUserByPhone(phone: string, sessionId: string): Promise<AuthUser> {
  const user = await prisma.user.findUnique({
    where: { phone },
    select: {
      id: true,
      name: true,
      phone: true,
      roleId: true,
      zoneId: true,
      parentId: true,
      subAdminAreas: { select: { area: true } },
    },
  });
  const role = user && ROLES.find((r) => r.id === user.roleId);
  if (!user || !role) throw new Error(`User ${phone} not found. Run npm run db:dev-data.`);
  return {
    id: user.id,
    sessionId,
    app: role.app,
    name: user.name,
    phone: user.phone,
    roleId: role.id,
    roleKey: role.key,
    tier: role.tier,
    zoneId: user.zoneId,
    parentId: user.parentId,
    subAdminAreas: user.subAdminAreas.map((grant) => grant.area),
  };
}

/**
 * Uploads one small PNG (a QR picture of `label`) as `actor` exactly like an app: signed
 * link → PUT to R2. Returns the public file URL to send to the API.
 */
export async function uploadTestPng(
  actor: AuthUser,
  purpose: "kyc" | "request_receipt" | "task_photo" | "ticket_photo",
  label: string
): Promise<string> {
  const image = await QRCode.toBuffer(label, { type: "png", width: 480, margin: 4 });
  const link = await createUploadLink(actor, {
    purpose,
    contentType: "image/png",
    sizeBytes: image.length,
  });
  const response = await fetch(link.uploadUrl, {
    method: "PUT",
    headers: link.headers,
    body: new Uint8Array(image),
  });
  if (!response.ok) {
    throw new Error(`R2 refused the upload (${response.status}). Check the R2_* settings.`);
  }
  return link.fileUrl;
}

/** A KYC photo for the sign-up's KYC step. */
export function uploadKycPhoto(actor: AuthUser, label: string): Promise<string> {
  return uploadTestPng(actor, "kyc", label);
}

/**
 * Fills in whatever is still left of a sign-up, step by step, as the backend reports it
 * (forward only). Returns "draft" when `stopAfterAccount` stopped it before the KYC step.
 */
export async function fillSignUpSteps(
  actor: AuthUser,
  partnerId: string,
  partner: TestPartner,
  zoneId: string
): Promise<"done" | "draft"> {
  for (let guard = 0; guard < 6; guard++) {
    const { nextStep } = await getOnboarding(partnerId);
    if (nextStep === "done") return "done";
    if (partner.stopAfterAccount && nextStep === "kyc_documents") return "draft";

    if (nextStep === "basic_info") {
      await saveBasicInfo(
        actor,
        partnerId,
        basicInfoSchemas.body.parse({
          name: partner.name,
          address: "1 Test Road",
          city: partner.city,
          state: "Maharashtra",
          pincode: partner.pincode,
          zoneId,
          partnerType: "carpenter",
        })
      );
    } else if (nextStep === "payout_account") {
      await savePayoutAccount(actor, partnerId, payoutAccountBody.parse(partner.account));
    } else if (nextStep === "kyc_documents") {
      const panPhotoUrl = await uploadKycPhoto(actor, `TEST PAN CARD ${partner.pan}`);
      const aadhaarPhotoUrl = await uploadKycPhoto(actor, `TEST AADHAAR CARD ${partner.aadhaar}`);
      await saveKyc(
        actor,
        partnerId,
        kycSchemas.body.parse({
          panNumber: partner.pan,
          panPhotoUrl,
          aadhaarNumber: partner.aadhaar,
          aadhaarPhotoUrl,
        })
      );
    } else if (nextStep === "submit") {
      await submitOnboarding(actor, partnerId);
    } else {
      // e.g. firm_details: this sign-up was started as a dealer / OEM by hand.
      throw new Error(
        `${partner.key} stopped at "${nextStep}", which this script doesn't fill in. Finish it in Apidog.`
      );
    }
    console.log(`      ${partner.key}: ${nextStep.replace("_", " ")} saved`);
  }
  throw new Error(`${partner.key}: the sign-up didn't finish after 6 steps.`);
}

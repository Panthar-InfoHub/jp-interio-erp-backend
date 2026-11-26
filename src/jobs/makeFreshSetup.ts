import { isProd } from "../config/env.js";
import { ROLE } from "../config/roles.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { createBrand } from "../services/brand.service.js";
import { createCategory } from "../services/category.service.js";
import { approve as approveKyc } from "../services/kyc.service.js";
import { addAccount } from "../services/payoutAccount.service.js";
import { createProduct } from "../services/product.service.js";
import { createBatch } from "../services/qrBatch.service.js";
import { scanCode } from "../services/scan.service.js";
import { createUser } from "../services/user.service.js";
import { createBrandSchemas } from "../validators/brand.schema.js";
import { createCategorySchemas } from "../validators/category.schema.js";
import { payoutAccountBody } from "../validators/onboarding.schema.js";
import { createProductSchemas } from "../validators/product.schema.js";
import { createQrBatchSchemas } from "../validators/qrBatch.schema.js";
import { createUserSchemas } from "../validators/user.schema.js";
import { authUserByPhone, uploadTestPng } from "./devPartnerHelpers.js";

/**
 * `npm run dev:fresh-setup` — DEV ONLY (test deployment on a fresh database, DEC-309, DEC-310).
 *
 * On a NEW database, makes the test items the panel testing guide expects that earlier
 * sessions made by hand, through the SAME services the panel uses:
 *
 *   1. X 9000000210 and Y 9000000211: KYC approved by the Admin (Y gets TEST Pune ASM 2).
 *   2. Partner E 9000000145: UPI ID teste@okaxis (default), so `dev:payout-test-data` can use E.
 *      E keeps its own number (DEC-311): moving it would let `db:dev-data` make a second E.
 *   3. Zonal Head with no zone: "TEST ZH No Zone" 9000000151 (the guide's ZH-NOZONE).
 *   4. Brand "TEST Setup Brand", category "TEST Setup Plywood", and the products
 *      TEST-SCAN-CHECK ("TEST Scan Check Ply") and BWP-18 ("TEST BWP Ply 18mm"), each with a
 *      small PNG uploaded to R2. Needed by `dev:request-test-data` and `check:parallel-scan`.
 *   5. The first QR batch (QRB-<year>-0001, 10 codes × 10 points on TEST-SCAN-CHECK), and
 *      partner C 9000000143 scans one code (C's "1 scan").
 *
 * Order on a fresh database: `db:deploy` → `db:seed` → `db:dev-data` →
 * `dev:kyc-test-partners` → **this script** → `dev:payout-test-data` →
 * `dev:request-test-data` → `dev:task-test-data` → `dev:ticket-test-data`.
 *
 * Safe to run again: every part that is already there is skipped with a note. Leaves
 * permanent rows (audit, points for C, files in R2). Refuses to run when NODE_ENV=production.
 */

const SESSION = "fresh-setup";
const PUNE_ASM_2 = "919000000122";
const E_PHONE = "919000000145";
const E_UPI = "teste@okaxis";
const C_PHONE = "919000000143";
const ZH_NO_ZONE_PHONE = "919000000151";
const BRAND_NAME = "TEST Setup Brand";
const CATEGORY_NAME = "TEST Setup Plywood";

const PRODUCTS = [
  { sku: "TEST-SCAN-CHECK", name: "TEST Scan Check Ply", mrp: "1000", thickness: "12mm" },
  { sku: "BWP-18", name: "TEST BWP Ply 18mm", mrp: "2400", thickness: "18mm" },
] as const;

const done = (what: string) => console.log(`DONE  ${what}`);
const skip = (what: string) => console.log(`SKIP  ${what}`);

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

/** 1. X and Y: approve their pending KYC. */
async function approveXandY(admin: AuthUser): Promise<void> {
  const asm2 = await prisma.user.findUnique({ where: { phone: PUNE_ASM_2 }, select: { id: true } });
  const partners = [
    { key: "X", phone: "919000000210", asmId: undefined },
    { key: "Y", phone: "919000000211", asmId: asm2?.id },
  ];
  for (const partner of partners) {
    const user = await prisma.user.findUnique({
      where: { phone: partner.phone },
      select: { id: true, partnerProfile: { select: { kycState: true } } },
    });
    const state = user?.partnerProfile?.kycState;
    if (!user) {
      skip(`${partner.key}: not found (run npm run dev:kyc-test-partners first)`);
    } else if (state !== "pending") {
      skip(`${partner.key}: KYC ${state ?? "?"}, nothing to approve`);
    } else {
      await approveKyc(admin, "full", user.id, partner.asmId);
      done(`${partner.key}: KYC approved`);
    }
  }
}

/** 2. Partner E: a UPI ID (its first account, so the default) for the payout test data. */
async function ensureEUpi(admin: AuthUser): Promise<void> {
  const e = await prisma.user.findUnique({ where: { phone: E_PHONE }, select: { id: true } });
  if (!e) return skip(`E: not found on ${E_PHONE.slice(2)} (run npm run db:dev-data first)`);
  const account = await prisma.payoutAccount.findFirst({
    where: { partnerId: e.id, removedAt: null },
    select: { id: true },
  });
  if (account) return skip("E: already has a payout account");
  await addAccount(
    admin,
    "full",
    e.id,
    payoutAccountBody.parse({ method: "upi", upiId: E_UPI, holderName: "TEST Partner E" })
  );
  done(`E: UPI ${E_UPI} (default)`);
}

/** 3. A Zonal Head with no zone (ZH-NOZONE). */
async function ensureZonalHeadWithoutZone(admin: AuthUser): Promise<void> {
  const existing = await prisma.user.findUnique({
    where: { phone: ZH_NO_ZONE_PHONE },
    select: { id: true },
  });
  if (existing) return skip(`ZH-NOZONE: ${ZH_NO_ZONE_PHONE.slice(2)} already exists`);
  await createUser(
    admin,
    createUserSchemas.body.parse({
      role: "zonal_head",
      name: "TEST ZH No Zone",
      phone: ZH_NO_ZONE_PHONE.slice(2),
      zoneId: null,
    })
  );
  done(`ZH-NOZONE: "TEST ZH No Zone" ${ZH_NO_ZONE_PHONE.slice(2)}, no zone`);
}

/** 4. Brand, category and the two products the dev scripts use. Returns TEST-SCAN-CHECK's id. */
async function ensureProducts(admin: AuthUser): Promise<string> {
  let brand = await prisma.brand.findFirst({ where: { name: BRAND_NAME }, select: { id: true } });
  if (brand) {
    skip(`brand "${BRAND_NAME}" already exists`);
  } else {
    brand = await createBrand(admin, createBrandSchemas.body.parse({ name: BRAND_NAME }));
    done(`brand "${BRAND_NAME}"`);
  }

  let category = await prisma.productCategory.findFirst({
    where: { name: CATEGORY_NAME, parentId: null },
    select: { id: true },
  });
  if (category) {
    skip(`category "${CATEGORY_NAME}" already exists`);
  } else {
    category = await createCategory(
      admin,
      createCategorySchemas.body.parse({ name: CATEGORY_NAME })
    );
    done(`category "${CATEGORY_NAME}"`);
  }

  let scanCheckId: string | undefined;
  for (const item of PRODUCTS) {
    const existing = await prisma.product.findFirst({
      where: { sku: { equals: item.sku, mode: "insensitive" } },
      select: { id: true },
    });
    if (existing) {
      skip(`product ${item.sku} already exists`);
      if (item.sku === "TEST-SCAN-CHECK") scanCheckId = existing.id;
      continue;
    }
    const imageUrl = await uploadTestPng(admin, "product_image", `TEST PRODUCT ${item.sku}`);
    const product = await createProduct(
      admin,
      createProductSchemas.body.parse({
        sku: item.sku,
        name: item.name,
        brandId: brand.id,
        categoryId: category.id,
        thickness: item.thickness,
        mrp: item.mrp,
        imageUrl,
      })
    );
    done(`product ${item.sku} "${item.name}"`);
    if (item.sku === "TEST-SCAN-CHECK") scanCheckId = product.id;
  }
  if (!scanCheckId) throw new Error("TEST-SCAN-CHECK could not be found or made.");
  return scanCheckId;
}

/** 5. The first QR batch, and partner C scans one of its codes. */
async function ensureFirstBatchAndScan(admin: AuthUser, productId: string): Promise<void> {
  let batch = await prisma.qrBatch.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true, batchNo: true },
  });
  if (batch) {
    skip(`QR batch: the first batch already exists (${batch.batchNo})`);
  } else {
    batch = await createBatch(
      admin,
      createQrBatchSchemas.body.parse({
        productId,
        quantity: 10,
        pointsPerCode: 10,
        notes: "TEST setup batch: partner C scans one code (dev:fresh-setup)",
      })
    );
    done(`QR batch ${batch.batchNo} (10 codes × 10 points, TEST-SCAN-CHECK)`);
  }

  const c = await prisma.user.findUnique({
    where: { phone: C_PHONE },
    select: { id: true, partnerProfile: { select: { kycState: true } } },
  });
  if (!c) return skip(`C: not found (run npm run db:dev-data first)`);
  if (c.partnerProfile?.kycState !== "verified") return skip(`C: KYC not verified, can't scan`);

  const scanned = await prisma.qrCode.findFirst({
    where: { scannedById: c.id },
    select: { code: true },
  });
  if (scanned) return skip(`C: already has a scan (${scanned.code})`);

  const code = await prisma.qrCode.findFirst({
    where: { batchId: batch.id, status: "active" },
    orderBy: { createdAt: "asc" },
    select: { code: true },
  });
  if (!code) return skip(`C: no unscanned code left in ${batch.batchNo}`);

  const me = await authUserByPhone(C_PHONE, SESSION);
  await scanCode(me, { code: code.code });
  done(`C: scanned ${code.code} from ${batch.batchNo}`);
}

async function main() {
  if (isProd) throw new Error("This script is for the dev database only.");

  const admin = await findAdmin();
  await approveXandY(admin);
  await ensureEUpi(admin);
  await ensureZonalHeadWithoutZone(admin);
  const productId = await ensureProducts(admin);
  await ensureFirstBatchAndScan(admin, productId);

  console.log(
    "\nNext: npm run dev:payout-test-data → dev:request-test-data → dev:task-test-data → dev:ticket-test-data"
  );
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

import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { nameKey } from "../utils/catalogKeys.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";
import { pageMeta, toPrismaOrderBy, toPrismaPaging } from "../utils/pagination.js";
import type {
  CreateBrandInput,
  ListBrandsQuery,
  UpdateBrandInput,
} from "../validators/brand.schema.js";
import { recordAudit } from "./audit.service.js";

/**
 * Brands (Module 6, Task 2).
 * - Managed by the Admin and the Products & Catalog Sub-Admin (`products.manage`, DEC-108).
 * - Never deleted, only switched off. A switched-off brand's products are hidden from the
 *   app catalog and cannot be picked in new requests; new QR batches are still allowed
 *   (DEC-110). That is enforced in the catalog / request code, not here.
 * - The name is unique ignoring case and extra spaces (`name_key`). The code is optional,
 *   saved in capitals, and unique when given (DEC-111).
 * - Every list row and detail shows how many products the brand has (all / switched on).
 */

const BRAND_FIELDS = {
  id: true,
  name: true,
  code: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BrandSelect;

type BrandRow = Prisma.BrandGetPayload<{ select: typeof BRAND_FIELDS }>;

/** Adds product counts to each brand, with one query in total (not one per brand). */
async function withProductCounts(brands: BrandRow[]) {
  const brandIds = brands.map((brand) => brand.id);
  if (brandIds.length === 0) return [];

  const counts = await prisma.product.groupBy({
    by: ["brandId", "active"],
    where: { brandId: { in: brandIds } },
    _count: { _all: true },
  });

  return brands.map((brand) => {
    const rows = counts.filter((row) => row.brandId === brand.id);
    const total = rows.reduce((sum, row) => sum + row._count._all, 0);
    const active = rows.find((row) => row.active)?._count._all ?? 0;
    return { ...brand, productCounts: { total, active, inactive: total - active } };
  });
}

/** The brand with this id, or 404. */
async function findBrand(id: string): Promise<BrandRow> {
  const brand = await prisma.brand.findUnique({ where: { id }, select: BRAND_FIELDS });
  if (!brand) throw new NotFoundError("Brand not found");
  return brand;
}

/** A clear 409 before the database's own unique check (which stays as the safety net). */
async function assertNameFree(name: string, exceptBrandId?: string) {
  const taken = await prisma.brand.findFirst({
    where: { nameKey: nameKey(name), ...(exceptBrandId && { id: { not: exceptBrandId } }) },
    select: { name: true },
  });
  if (taken) throw new ConflictError(`A brand named "${taken.name}" already exists`);
}

async function assertCodeFree(code: string, exceptBrandId?: string) {
  const taken = await prisma.brand.findFirst({
    where: { code, ...(exceptBrandId && { id: { not: exceptBrandId } }) },
    select: { name: true },
  });
  if (taken) throw new ConflictError(`Brand "${taken.name}" already uses the code ${code}`);
}

/** GET /brands — paginated, with search and on/off filter. */
export async function listBrands(query: ListBrandsQuery) {
  const where: Prisma.BrandWhereInput = {
    ...(query.status && { active: query.status === "active" }),
    ...(query.search && {
      OR: (["name", "code"] as const).map((field) => ({
        [field]: { contains: query.search, mode: "insensitive" },
      })),
    }),
  };

  const [brands, total] = await Promise.all([
    prisma.brand.findMany({
      where,
      select: BRAND_FIELDS,
      orderBy: toPrismaOrderBy(query.sort),
      ...toPrismaPaging(query.page, query.limit),
    }),
    prisma.brand.count({ where }),
  ]);

  return { items: await withProductCounts(brands), meta: pageMeta(query.page, query.limit, total) };
}

/** GET /brands/:id */
export async function getBrand(id: string) {
  const [brand] = await withProductCounts([await findBrand(id)]);
  return brand!;
}

/** POST /brands */
export async function createBrand(actor: AuthUser, input: CreateBrandInput) {
  const code = input.code ?? null;
  await assertNameFree(input.name);
  if (code) await assertCodeFree(code);

  const brand = await prisma.$transaction(async (tx) => {
    const created = await tx.brand.create({
      data: { name: input.name, nameKey: nameKey(input.name), code },
      select: BRAND_FIELDS,
    });
    await recordAudit(tx, {
      actorId: actor.id,
      action: "brand.create",
      entity: { type: "brand", id: created.id },
      after: { name: created.name, code: created.code, active: created.active },
    });
    return created;
  });

  return getBrand(brand.id);
}

/**
 * PATCH /brands/:id. Only the fields that really change are saved and audited.
 * Changing only the capitals of the name ("greenply" → "GreenPly") is allowed.
 */
export async function updateBrand(actor: AuthUser, id: string, input: UpdateBrandInput) {
  const brand = await findBrand(id);

  const changes: { name?: string; code?: string | null } = {};
  if (input.name !== undefined && input.name !== brand.name) changes.name = input.name;
  if (input.code !== undefined && input.code !== brand.code) changes.code = input.code;
  if (Object.keys(changes).length === 0) return { brand: await getBrand(id), changed: false };

  if (changes.name !== undefined) await assertNameFree(changes.name, id);
  if (changes.code) await assertCodeFree(changes.code, id);

  await prisma.$transaction(async (tx) => {
    await tx.brand.update({
      where: { id },
      data: {
        ...changes,
        ...(changes.name !== undefined && { nameKey: nameKey(changes.name) }),
      },
    });
    await recordAudit(tx, {
      actorId: actor.id,
      action: "brand.update",
      entity: { type: "brand", id },
      before: Object.fromEntries(
        Object.keys(changes).map((key) => [key, brand[key as keyof typeof changes]])
      ),
      after: changes,
    });
  });

  return { brand: await getBrand(id), changed: true };
}

/** Shared by deactivate and reactivate. The same state again changes nothing. */
async function setActive(actor: AuthUser, id: string, active: boolean) {
  const brand = await findBrand(id);
  if (brand.active === active) return { brand: await getBrand(id), changed: false };

  await prisma.$transaction(async (tx) => {
    await tx.brand.update({ where: { id }, data: { active } });
    await recordAudit(tx, {
      actorId: actor.id,
      action: active ? "brand.reactivate" : "brand.deactivate",
      entity: { type: "brand", id },
      before: { active: brand.active },
      after: { active },
    });
  });

  return { brand: await getBrand(id), changed: true };
}

/** POST /brands/:id/deactivate */
export const deactivateBrand = (actor: AuthUser, id: string) => setActive(actor, id, false);

/** POST /brands/:id/reactivate */
export const reactivateBrand = (actor: AuthUser, id: string) => setActive(actor, id, true);

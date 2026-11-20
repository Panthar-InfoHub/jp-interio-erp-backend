import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { skuKey } from "../utils/catalogKeys.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";
import { pageMeta, toPrismaOrderBy, toPrismaPaging } from "../utils/pagination.js";
import type {
  CreateProductInput,
  ListProductsQuery,
  UpdateProductInput,
} from "../validators/product.schema.js";
import type { ListQrProductsQuery } from "../validators/qrBatch.schema.js";
import { recordAudit } from "./audit.service.js";
import {
  type CategoryIndex,
  isEffectivelyActive,
  loadCategoryIndex,
  pathOf,
  selfAndDescendantIds,
  switchedOffAbove,
} from "./categoryTree.js";
import { deleteFile, verifyUploadedFile } from "./storage.service.js";

/**
 * Products for staff (Module 6, Task 5).
 * - Managed by the Admin and the Products & Catalog Sub-Admin (`products.manage`, DEC-108);
 *   nobody else sees this full list (DEC-114).
 * - Never deleted, only switched off.
 * - SKU unique ignoring case and spaces (`sku_key`, DEC-111); it can be changed (DEC-114)
 *   until the product gets its first QR batch, then it is locked for good (DEC-122).
 * - One required image, uploaded with purpose `product_image`; replacing it deletes the old
 *   file from R2 after the save (DEC-110, DEC-113).
 * - Added to / moved to only a brand that is on and a category that is effectively on (DEC-114).
 * - Each product shows whether it is really visible in the apps, and why not.
 */

const PRODUCT_FIELDS = {
  id: true,
  sku: true,
  name: true,
  thickness: true,
  size: true,
  grade: true,
  mrp: true,
  imageUrl: true,
  active: true,
  categoryId: true,
  createdAt: true,
  updatedAt: true,
  brand: { select: { id: true, name: true, code: true, active: true } },
  _count: { select: { qrBatches: true } },
} satisfies Prisma.ProductSelect;

type ProductRow = Prisma.ProductGetPayload<{ select: typeof PRODUCT_FIELDS }>;

const SKU_LOCKED_MESSAGE = "SKU can't be changed: this product already has QR batches";

/** Why a product is not shown in the apps; empty = shown (DEC-108, DEC-110). */
function hiddenReasons(index: CategoryIndex, product: ProductRow): string[] {
  const reasons: string[] = [];
  if (!product.active) reasons.push("The product is switched off");
  if (!product.brand.active) reasons.push(`Brand "${product.brand.name}" is switched off`);
  const category = index.byId.get(product.categoryId);
  if (category && !category.active) reasons.push(`Category "${category.name}" is switched off`);
  for (const above of switchedOffAbove(index, product.categoryId)) {
    reasons.push(`Category "${above.name}" is switched off`);
  }
  return reasons;
}

/** The reply shape for one product. MRP as text ("1250.00") so no rounding ever happens. */
function present(index: CategoryIndex, product: ProductRow) {
  const { categoryId, mrp, _count, ...rest } = product;
  const category = index.byId.get(categoryId);
  const hiddenBecause = hiddenReasons(index, product);
  return {
    ...rest,
    mrp: mrp.toFixed(2),
    /** True once the product has any QR batch, even a voided one (DEC-122). */
    skuLocked: _count.qrBatches > 0,
    category: {
      id: categoryId,
      name: category?.name ?? null,
      active: category?.active ?? false,
      effectiveActive: isEffectivelyActive(index, categoryId),
      path: pathOf(index, categoryId),
    },
    visibleInApp: hiddenBecause.length === 0,
    hiddenBecause,
  };
}

async function findProduct(id: string): Promise<ProductRow> {
  const product = await prisma.product.findUnique({ where: { id }, select: PRODUCT_FIELDS });
  if (!product) throw new NotFoundError("Product not found");
  return product;
}

/** A clear 409 before the database's own unique check (which stays as the safety net). */
async function assertSkuFree(sku: string, exceptProductId?: string) {
  const taken = await prisma.product.findFirst({
    where: { skuKey: skuKey(sku), ...(exceptProductId && { id: { not: exceptProductId } }) },
    select: { sku: true, name: true },
  });
  if (taken) {
    throw new ConflictError(`SKU ${taken.sku} is already used by "${taken.name}"`);
  }
}

/** A brand a product can be added to / moved to: exists and is on (DEC-114). */
async function assertUsableBrand(brandId: string) {
  const brand = await prisma.brand.findUnique({
    where: { id: brandId },
    select: { name: true, active: true },
  });
  if (!brand) throw new NotFoundError("Brand not found");
  if (!brand.active) {
    throw new ConflictError(`Brand "${brand.name}" is switched off. Switch it on first.`);
  }
}

/** A category a product can be added to / moved to: exists and is effectively on (DEC-114). */
function assertUsableCategory(index: CategoryIndex, categoryId: string) {
  if (!index.byId.has(categoryId)) throw new NotFoundError("Category not found");
  if (!isEffectivelyActive(index, categoryId)) {
    const path = pathOf(index, categoryId)
      .map((step) => step.name)
      .join(" › ");
    throw new ConflictError(`"${path}" is switched off. Switch it on first.`);
  }
}

/** GET /products — paginated, with filters. */
export async function listProducts(query: ListProductsQuery) {
  const index = await loadCategoryIndex(prisma);

  const where: Prisma.ProductWhereInput = {
    ...(query.brandId && { brandId: query.brandId }),
    // A category also covers everything below it (DEC-109). Unknown id = empty list.
    ...(query.categoryId && {
      categoryId: { in: [...selfAndDescendantIds(index, query.categoryId)] },
    }),
    ...(query.thickness && { thickness: { contains: query.thickness, mode: "insensitive" } }),
    ...(query.grade && { grade: { contains: query.grade, mode: "insensitive" } }),
    ...(query.status && { active: query.status === "active" }),
    ...(query.search && {
      OR: [
        { sku: { contains: query.search, mode: "insensitive" } },
        { name: { contains: query.search, mode: "insensitive" } },
        // "bwp 18" also finds "BWP18MM": spaces and case ignored, like the SKU rule.
        ...(skuKey(query.search) ? [{ skuKey: { contains: skuKey(query.search) } }] : []),
      ],
    }),
  };

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      select: PRODUCT_FIELDS,
      orderBy: toPrismaOrderBy(query.sort),
      ...toPrismaPaging(query.page, query.limit),
    }),
    prisma.product.count({ where }),
  ]);

  return {
    items: products.map((product) => present(index, product)),
    meta: pageMeta(query.page, query.limit, total),
  };
}

/** GET /products/:id */
export async function getProduct(id: string) {
  const [product, index] = await Promise.all([findProduct(id), loadCategoryIndex(prisma)]);
  return present(index, product);
}

/** POST /products */
export async function createProduct(actor: AuthUser, input: CreateProductInput) {
  const index = await loadCategoryIndex(prisma);
  await assertUsableBrand(input.brandId);
  assertUsableCategory(index, input.categoryId);
  await assertSkuFree(input.sku);
  await verifyUploadedFile(actor, "product_image", input.imageUrl, "product image");

  const created = await prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        sku: input.sku,
        skuKey: skuKey(input.sku),
        name: input.name,
        brandId: input.brandId,
        categoryId: input.categoryId,
        thickness: input.thickness ?? null,
        size: input.size ?? null,
        grade: input.grade ?? null,
        mrp: input.mrp,
        imageUrl: input.imageUrl,
      },
      select: { id: true },
    });
    await recordAudit(tx, {
      actorId: actor.id,
      action: "product.create",
      entity: { type: "product", id: product.id },
      after: {
        sku: input.sku,
        name: input.name,
        brandId: input.brandId,
        categoryId: input.categoryId,
        thickness: input.thickness ?? null,
        size: input.size ?? null,
        grade: input.grade ?? null,
        mrp: input.mrp,
        imageUrl: input.imageUrl,
      },
    });
    return product;
  });

  return getProduct(created.id);
}

type EditableField =
  "sku" | "name" | "brandId" | "categoryId" | "thickness" | "size" | "grade" | "mrp" | "imageUrl";

/**
 * PATCH /products/:id. Only fields that really change are saved and audited.
 * A new image is checked before saving; the old file is deleted from R2 after the save.
 */
export async function updateProduct(actor: AuthUser, id: string, input: UpdateProductInput) {
  const current = await prisma.product.findUnique({
    where: { id },
    select: {
      sku: true,
      name: true,
      brandId: true,
      categoryId: true,
      thickness: true,
      size: true,
      grade: true,
      mrp: true,
      imageUrl: true,
    },
  });
  if (!current) throw new NotFoundError("Product not found");

  const before: Record<string, unknown> = {};
  const changes: Partial<Record<EditableField, string | null>> = {};
  for (const field of Object.keys(input) as EditableField[]) {
    const value = input[field];
    if (value === undefined) continue;
    const old = current[field];
    const same =
      field === "mrp" ? current.mrp.equals(value as string) : (old as string | null) === value;
    if (same) continue;
    changes[field] = value;
    before[field] = field === "mrp" ? current.mrp.toFixed(2) : old;
  }
  if (Object.keys(changes).length === 0) return { product: await getProduct(id), changed: false };

  if (changes.sku !== undefined) {
    // Locked once the product has any QR batch, even for capitals / spaces only (DEC-122).
    // Checked again inside the transaction below, in case a batch is made meanwhile.
    if ((await prisma.qrBatch.count({ where: { productId: id } })) > 0) {
      throw new ConflictError(SKU_LOCKED_MESSAGE);
    }
    // Changing only capitals or spaces keeps the same key: no clash with itself.
    await assertSkuFree(changes.sku!, id);
  }
  if (changes.brandId !== undefined) await assertUsableBrand(changes.brandId!);
  if (changes.categoryId !== undefined) {
    assertUsableCategory(await loadCategoryIndex(prisma), changes.categoryId!);
  }
  if (changes.imageUrl !== undefined) {
    await verifyUploadedFile(actor, "product_image", changes.imageUrl!, "product image");
  }

  await prisma.$transaction(async (tx) => {
    await tx.product.update({
      where: { id },
      data: {
        ...(changes as Prisma.ProductUncheckedUpdateInput),
        ...(changes.sku !== undefined && { skuKey: skuKey(changes.sku!) }),
      },
    });
    // The update above holds the product row; making a QR batch first takes a share lock on
    // the same row (qrBatch.service), so one always waits for the other. If a batch got in
    // first, it is seen here and the whole change is undone.
    if (changes.sku !== undefined && (await tx.qrBatch.count({ where: { productId: id } })) > 0) {
      throw new ConflictError(SKU_LOCKED_MESSAGE);
    }
    await recordAudit(tx, {
      actorId: actor.id,
      action: "product.update",
      entity: { type: "product", id },
      before,
      after: changes,
    });
  });

  // Only after the save worked: the old image is no longer used anywhere (DEC-113).
  if (changes.imageUrl !== undefined) await deleteFile(current.imageUrl);

  return { product: await getProduct(id), changed: true };
}

/** Shared by deactivate and reactivate. The same state again changes nothing. */
async function setActive(actor: AuthUser, id: string, active: boolean) {
  const product = await findProduct(id);
  if (product.active === active) return { product: await getProduct(id), changed: false };

  await prisma.$transaction(async (tx) => {
    await tx.product.update({ where: { id }, data: { active } });
    await recordAudit(tx, {
      actorId: actor.id,
      action: active ? "product.reactivate" : "product.deactivate",
      entity: { type: "product", id },
      before: { active: product.active },
      after: { active },
    });
  });

  return { product: await getProduct(id), changed: true };
}

/** POST /products/:id/deactivate */
export const deactivateProduct = (actor: AuthUser, id: string) => setActive(actor, id, false);

/** POST /products/:id/reactivate */
export const reactivateProduct = (actor: AuthUser, id: string) => setActive(actor, id, true);

// ---------------------------------------------------------------------------
// Product picker for the QR batch screen (Module 7 T3, DEC-122)
// ---------------------------------------------------------------------------

/**
 * GET /qr/products — switched-on products only (a switched-off product can't get a batch),
 * INCLUDING ones whose brand or category is off (DEC-110). `notes` says when that is so,
 * e.g. `Brand "GreenPly" is switched off`; empty = brand and categories all on.
 */
export async function listProductsForQrBatch(query: ListQrProductsQuery) {
  const index = await loadCategoryIndex(prisma);

  const where: Prisma.ProductWhereInput = {
    active: true,
    ...(query.brandId && { brandId: query.brandId }),
    // A category also covers everything below it (DEC-109). Unknown id = empty list.
    ...(query.categoryId && {
      categoryId: { in: [...selfAndDescendantIds(index, query.categoryId)] },
    }),
    ...(query.search && {
      OR: [
        { sku: { contains: query.search, mode: "insensitive" } },
        { name: { contains: query.search, mode: "insensitive" } },
        ...(skuKey(query.search) ? [{ skuKey: { contains: skuKey(query.search) } }] : []),
      ],
    }),
  };

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      select: PRODUCT_FIELDS,
      orderBy: toPrismaOrderBy(query.sort),
      ...toPrismaPaging(query.page, query.limit),
    }),
    prisma.product.count({ where }),
  ]);

  const items = products.map((product) => {
    const category = index.byId.get(product.categoryId);
    return {
      id: product.id,
      sku: product.sku,
      name: product.name,
      thickness: product.thickness,
      size: product.size,
      grade: product.grade,
      mrp: product.mrp.toFixed(2),
      imageUrl: product.imageUrl,
      brand: { id: product.brand.id, name: product.brand.name },
      category: {
        id: product.categoryId,
        name: category?.name ?? null,
        path: pathOf(index, product.categoryId),
      },
      // The product itself is on here, so only brand / category reasons can appear.
      notes: hiddenReasons(index, product),
    };
  });

  return { items, meta: pageMeta(query.page, query.limit, total) };
}

// ---------------------------------------------------------------------------
// Shared check for later modules (DEC-110, DEC-114)
// ---------------------------------------------------------------------------

/** What the product is being used for. */
export type ProductUse = "request" | "qr_batch";

/**
 * Throws unless the product can be used right now:
 * - `request` (Module 11): the product, its brand and its whole category chain are on.
 * - `qr_batch` (Module 7): only the product itself must be on; a switched-off brand or
 *   category does not block new QR batches (DEC-110).
 * Pass `tx` to read inside the caller's transaction. Unknown id → 404.
 */
export async function assertProductUsable(
  productId: string,
  use: ProductUse,
  db: Prisma.TransactionClient = prisma
): Promise<{ id: string; sku: string; name: string }> {
  const product = await db.product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      sku: true,
      name: true,
      active: true,
      categoryId: true,
      brand: { select: { name: true, active: true } },
    },
  });
  if (!product) throw new NotFoundError("Product not found");
  const label = `"${product.name}" (${product.sku})`;

  if (!product.active) throw new ConflictError(`Product ${label} is switched off`);
  if (use === "request") {
    if (!product.brand.active) {
      throw new ConflictError(
        `Product ${label} cannot be requested: brand "${product.brand.name}" is switched off`
      );
    }
    const index = await loadCategoryIndex(db);
    if (!isEffectivelyActive(index, product.categoryId)) {
      throw new ConflictError(`Product ${label} cannot be requested: its category is switched off`);
    }
  }
  return { id: product.id, sku: product.sku, name: product.name };
}

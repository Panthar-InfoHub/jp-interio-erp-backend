import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { skuKey } from "../utils/catalogKeys.js";
import { NotFoundError } from "../utils/errors.js";
import { pageMeta, toPrismaOrderBy, toPrismaPaging } from "../utils/pagination.js";
import type { CatalogProductsQuery } from "../validators/catalog.schema.js";
import {
  type CategoryIndex,
  effectivelyActiveIds,
  loadCategoryIndex,
  pathOf,
  selfAndDescendantIds,
} from "./categoryTree.js";

/**
 * The app catalog (Module 6, Task 6): the one read-only product list for the Partner App and
 * the Field App, and for every staff role outside the catalog team (DEC-108, DEC-114).
 * - Shows a product only when its own switch, its brand, and its category plus every
 *   category above it are all on (DEC-108, DEC-110). A hidden product is a 404.
 * - Filters: brand, category (including everything below it), text search (DEC-111, DEC-115).
 * - The filter lists show every switched-on brand and category, even empty ones (DEC-115).
 * - Light fields only: no on/off flags, counts or dates.
 */

const CATALOG_FIELDS = {
  id: true,
  sku: true,
  name: true,
  thickness: true,
  size: true,
  grade: true,
  mrp: true,
  imageUrl: true,
  categoryId: true,
  brand: { select: { id: true, name: true } },
} satisfies Prisma.ProductSelect;

type CatalogRow = Prisma.ProductGetPayload<{ select: typeof CATALOG_FIELDS }>;

/** Products the apps may show, limited to the given categories. */
function visibleWhere(categoryIds: Iterable<string>): Prisma.ProductWhereInput {
  return { active: true, brand: { active: true }, categoryId: { in: [...categoryIds] } };
}

function present(index: CategoryIndex, product: CatalogRow) {
  const { categoryId, mrp, ...rest } = product;
  return {
    ...rest,
    mrp: mrp.toFixed(2),
    category: {
      id: categoryId,
      name: index.byId.get(categoryId)?.name ?? null,
      path: pathOf(index, categoryId),
    },
  };
}

/** GET /catalog/products — paginated. */
export async function listCatalogProducts(query: CatalogProductsQuery) {
  const index = await loadCategoryIndex(prisma);
  let categoryIds = effectivelyActiveIds(index);
  if (query.categoryId) {
    // Below a switched-off (or unknown) category nothing is visible: empty list.
    const wanted = selfAndDescendantIds(index, query.categoryId);
    categoryIds = new Set([...categoryIds].filter((id) => wanted.has(id)));
  }

  const where: Prisma.ProductWhereInput = {
    ...visibleWhere(categoryIds),
    ...(query.brandId && { brandId: query.brandId }),
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
      select: CATALOG_FIELDS,
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

/** GET /catalog/products/:id — 404 when the product does not exist or is hidden. */
export async function getCatalogProduct(id: string) {
  const index = await loadCategoryIndex(prisma);
  const product = await prisma.product.findFirst({
    where: { id, ...visibleWhere(effectivelyActiveIds(index)) },
    select: CATALOG_FIELDS,
  });
  if (!product) throw new NotFoundError("Product not found");
  return present(index, product);
}

type CatalogCategory = { id: string; name: string; children: CatalogCategory[] };

/** GET /catalog/categories — the switched-on tree, nested, sorted by name. */
export async function getCatalogCategories(): Promise<CatalogCategory[]> {
  const index = await loadCategoryIndex(prisma);
  const build = (parentId: string | null): CatalogCategory[] =>
    (index.childrenOf.get(parentId) ?? [])
      // An off category hides itself and everything below it.
      .filter((node) => node.active)
      .map((node) => ({ id: node.id, name: node.name, children: build(node.id) }));
  return build(null);
}

/** GET /catalog/brands — switched-on brands, sorted by name. A short list: not paged. */
export async function getCatalogBrands() {
  return prisma.brand.findMany({
    where: { active: true },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { nameKey } from "../utils/catalogKeys.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";
import type { CreateCategoryInput, UpdateCategoryInput } from "../validators/category.schema.js";
import { recordAudit } from "./audit.service.js";
import {
  type CategoryIndex,
  type CategoryNode,
  isEffectivelyActive,
  loadCategoryIndex,
  pathOf,
  selfAndDescendantIds,
  switchedOffAbove,
} from "./categoryTree.js";

/**
 * Product categories (Module 6, Task 3).
 * - Managed by the Admin and the Products & Catalog Sub-Admin (`products.manage`, DEC-108).
 * - Nested as deep as the Admin wants; never deleted, only switched off (DEC-108).
 * - Each category has its own switch. It is "effectively on" only when its own switch and
 *   every switch above it are on, so switching a parent off hides everything below it, and
 *   switching it back on brings back what was not switched off by itself (DEC-110, DEC-111).
 * - Names are unique among categories under the same parent, ignoring case (DEC-111).
 * - A category can be moved; never under itself or its own sub-categories (DEC-111),
 *   and never under a switched-off parent (DEC-112). Adding works the same way.
 * - Product counts: placed directly on it, and including everything below (DEC-112).
 *
 * Every change runs under one lock for the whole tree, so two adds or moves at the same
 * moment cannot break the name or "no loop" rules between them.
 */

type Db = Prisma.TransactionClient;

/** One lock for all category changes (a Postgres transaction-level advisory lock). */
async function lockCategoryTree(tx: Db) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"catalog:product_categories"}::text, 0))`;
}

type Count = { total: number; active: number };
type ProductCounts = { direct: Count; includingBelow: Count };

/** Product counts (all / switched on) for every category that has products directly on it. */
async function loadDirectCounts(): Promise<Map<string, Count>> {
  const rows = await prisma.product.groupBy({
    by: ["categoryId", "active"],
    _count: { _all: true },
  });
  const counts = new Map<string, Count>();
  for (const row of rows) {
    const count = counts.get(row.categoryId) ?? { total: 0, active: 0 };
    count.total += row._count._all;
    if (row.active) count.active += row._count._all;
    counts.set(row.categoryId, count);
  }
  return counts;
}

function countsFor(index: CategoryIndex, direct: Map<string, Count>, id: string): ProductCounts {
  const below: Count = { total: 0, active: 0 };
  for (const categoryId of selfAndDescendantIds(index, id)) {
    const count = direct.get(categoryId);
    if (!count) continue;
    below.total += count.total;
    below.active += count.active;
  }
  return { direct: direct.get(id) ?? { total: 0, active: 0 }, includingBelow: below };
}

/** Own switch, effective state, and the nearest switched-off category above (if any). */
function switchState(index: CategoryIndex, node: CategoryNode) {
  const offAbove = switchedOffAbove(index, node.id);
  const nearest = offAbove.at(-1);
  return {
    active: node.active,
    effectiveActive: node.active && offAbove.length === 0,
    offBecauseOf: nearest ? { id: nearest.id, name: nearest.name } : null,
  };
}

/** The category from the index, or 404. */
function findIn(index: CategoryIndex, id: string): CategoryNode {
  const node = index.byId.get(id);
  if (!node) throw new NotFoundError("Category not found");
  return node;
}

/** A parent for a new or moved category: must exist and be effectively on (DEC-112). */
function assertUsableParent(index: CategoryIndex, parentId: string) {
  const parent = index.byId.get(parentId);
  if (!parent) throw new NotFoundError("Parent category not found");
  if (!isEffectivelyActive(index, parentId)) {
    const path = pathOf(index, parentId)
      .map((step) => step.name)
      .join(" › ");
    throw new ConflictError(
      `"${path}" is switched off. Switch it on first, or choose another parent.`
    );
  }
}

/** Unique among the categories under the same parent, ignoring case (DEC-111). */
function assertNameFree(
  index: CategoryIndex,
  parentId: string | null,
  name: string,
  exceptId?: string
) {
  const key = nameKey(name);
  const clash = (index.childrenOf.get(parentId) ?? []).find(
    (sibling) => sibling.id !== exceptId && nameKey(sibling.name) === key
  );
  if (!clash) return;
  const where =
    parentId === null ? "at the top level" : `under "${index.byId.get(parentId)?.name}"`;
  throw new ConflictError(`A category named "${clash.name}" already exists ${where}`);
}

/** GET /categories/tree — the whole tree, nested, on and off, with counts. */
export async function getCategoryTree() {
  const [index, direct] = await Promise.all([loadCategoryIndex(prisma), loadDirectCounts()]);

  type TreeNode = ReturnType<typeof switchState> & {
    id: string;
    name: string;
    parentId: string | null;
    productCounts: ProductCounts;
    children: TreeNode[];
  };
  const build = (parentId: string | null): TreeNode[] =>
    (index.childrenOf.get(parentId) ?? []).map((node) => ({
      id: node.id,
      name: node.name,
      parentId: node.parentId,
      ...switchState(index, node),
      productCounts: countsFor(index, direct, node.id),
      children: build(node.id),
    }));

  return build(null);
}

/** GET /categories/:id — path, direct sub-categories, counts. */
export async function getCategory(id: string) {
  const [index, direct, row] = await Promise.all([
    loadCategoryIndex(prisma),
    loadDirectCounts(),
    prisma.productCategory.findUnique({
      where: { id },
      select: { createdAt: true, updatedAt: true },
    }),
  ]);
  const node = findIn(index, id);

  return {
    id: node.id,
    name: node.name,
    parentId: node.parentId,
    ...switchState(index, node),
    path: pathOf(index, id),
    children: (index.childrenOf.get(id) ?? []).map((child) => ({
      id: child.id,
      name: child.name,
      ...switchState(index, child),
    })),
    productCounts: countsFor(index, direct, id),
    createdAt: row!.createdAt,
    updatedAt: row!.updatedAt,
  };
}

/** POST /categories */
export async function createCategory(actor: AuthUser, input: CreateCategoryInput) {
  const parentId = input.parentId ?? null;

  const created = await prisma.$transaction(async (tx) => {
    await lockCategoryTree(tx);
    const index = await loadCategoryIndex(tx);
    if (parentId !== null) assertUsableParent(index, parentId);
    assertNameFree(index, parentId, input.name);

    const category = await tx.productCategory.create({
      data: { name: input.name, nameKey: nameKey(input.name), parentId },
      select: { id: true, name: true, parentId: true, active: true },
    });
    await recordAudit(tx, {
      actorId: actor.id,
      action: "category.create",
      entity: { type: "product_category", id: category.id },
      after: { name: category.name, parentId: category.parentId, active: category.active },
    });
    return category;
  });

  return getCategory(created.id);
}

/**
 * PATCH /categories/:id — rename and/or move. Everything below a moved category, and all
 * their products, move with it. Only real changes are saved and audited.
 */
export async function updateCategory(actor: AuthUser, id: string, input: UpdateCategoryInput) {
  const changed = await prisma.$transaction(async (tx) => {
    await lockCategoryTree(tx);
    const index = await loadCategoryIndex(tx);
    const node = findIn(index, id);

    const changes: { name?: string; parentId?: string | null } = {};
    if (input.name !== undefined && input.name !== node.name) changes.name = input.name;
    if (input.parentId !== undefined && input.parentId !== node.parentId) {
      changes.parentId = input.parentId;
    }
    if (Object.keys(changes).length === 0) return false;

    const newParentId = changes.parentId !== undefined ? changes.parentId : node.parentId;
    if (changes.parentId !== undefined && newParentId !== null) {
      if (selfAndDescendantIds(index, id).has(newParentId)) {
        throw new ConflictError(
          "A category cannot be moved under itself or under one of its own sub-categories"
        );
      }
      assertUsableParent(index, newParentId);
    }
    assertNameFree(index, newParentId, changes.name ?? node.name, id);

    await tx.productCategory.update({
      where: { id },
      data: {
        ...changes,
        ...(changes.name !== undefined && { nameKey: nameKey(changes.name) }),
      },
    });
    await recordAudit(tx, {
      actorId: actor.id,
      action: changes.parentId !== undefined ? "category.move" : "category.update",
      entity: { type: "product_category", id },
      before: Object.fromEntries(
        Object.keys(changes).map((key) => [key, node[key as keyof typeof changes]])
      ),
      after: changes,
    });
    return true;
  });

  return { category: await getCategory(id), changed };
}

/**
 * Shared by deactivate and reactivate: changes only this category's own switch.
 * - Off: everything below goes off with it (reported as `subCategoriesAffected`).
 * - On while a category above is still off: allowed, but it stays effectively off
 *   (reported as `stillOffBecauseOf`).
 */
async function setActive(actor: AuthUser, id: string, active: boolean) {
  const result = await prisma.$transaction(async (tx) => {
    await lockCategoryTree(tx);
    const index = await loadCategoryIndex(tx);
    const node = findIn(index, id);
    const offAbove = switchedOffAbove(index, id).map((above) => above.name);
    if (node.active === active) return { changed: false, offAbove, subCategoriesAffected: 0 };

    // Sub-categories whose own switch is on: they follow this category on or off.
    const subCategoriesAffected = [...selfAndDescendantIds(index, id)].filter(
      (categoryId) => categoryId !== id && index.byId.get(categoryId)!.active
    ).length;

    await tx.productCategory.update({ where: { id }, data: { active } });
    await recordAudit(tx, {
      actorId: actor.id,
      action: active ? "category.reactivate" : "category.deactivate",
      entity: { type: "product_category", id },
      before: { active: node.active },
      after: { active },
    });
    return { changed: true, offAbove, subCategoriesAffected };
  });

  return {
    category: await getCategory(id),
    changed: result.changed,
    subCategoriesAffected: result.subCategoriesAffected,
    stillOffBecauseOf: result.offAbove,
  };
}

/** POST /categories/:id/deactivate */
export const deactivateCategory = (actor: AuthUser, id: string) => setActive(actor, id, false);

/** POST /categories/:id/reactivate */
export const reactivateCategory = (actor: AuthUser, id: string) => setActive(actor, id, true);

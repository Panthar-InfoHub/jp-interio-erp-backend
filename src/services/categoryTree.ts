import type { Prisma } from "../generated/prisma/client.js";

/**
 * In-memory view of the product category tree (Module 6, DEC-109 – DEC-112).
 * The catalog has at most a few hundred categories, so the whole table is read in one
 * query and walked in memory: simpler and faster than a recursive query per request.
 *
 * Used by the category screens (T3), the product filters (T5) and the app catalog (T6):
 * - a product counts under its own category and every category above it;
 * - a category is "effectively on" only when its own switch and every switch above it are on.
 */

export type CategoryNode = {
  id: string;
  name: string;
  parentId: string | null;
  active: boolean;
};

export type CategoryIndex = {
  byId: Map<string, CategoryNode>;
  /** Direct children of each category; `null` = the top-level categories. Sorted by name. */
  childrenOf: Map<string | null, CategoryNode[]>;
};

type CategoryReader = Pick<Prisma.TransactionClient, "productCategory">;

/** Reads every category (on and off) and indexes them. Pass `tx` inside a transaction. */
export async function loadCategoryIndex(db: CategoryReader): Promise<CategoryIndex> {
  const rows = await db.productCategory.findMany({
    select: { id: true, name: true, parentId: true, active: true },
    orderBy: { name: "asc" },
  });

  const byId = new Map(rows.map((row) => [row.id, row]));
  const childrenOf = new Map<string | null, CategoryNode[]>();
  for (const row of rows) {
    const siblings = childrenOf.get(row.parentId) ?? [];
    siblings.push(row);
    childrenOf.set(row.parentId, siblings);
  }
  return { byId, childrenOf };
}

/** The categories above this one, top-level first (the category itself is not included). */
export function ancestorsOf(index: CategoryIndex, id: string): CategoryNode[] {
  const chain: CategoryNode[] = [];
  const seen = new Set<string>([id]);
  let parentId = index.byId.get(id)?.parentId ?? null;
  // `seen` guards against a loop, which the move rules never allow anyway.
  while (parentId !== null && !seen.has(parentId)) {
    const parent = index.byId.get(parentId);
    if (!parent) break;
    chain.unshift(parent);
    seen.add(parent.id);
    parentId = parent.parentId;
  }
  return chain;
}

/** Categories above this one whose own switch is off, top-level first. */
export function switchedOffAbove(index: CategoryIndex, id: string): CategoryNode[] {
  return ancestorsOf(index, id).filter((node) => !node.active);
}

/** On only when its own switch and every switch above it are on (DEC-110, DEC-111). */
export function isEffectivelyActive(index: CategoryIndex, id: string): boolean {
  const node = index.byId.get(id);
  return node !== undefined && node.active && switchedOffAbove(index, id).length === 0;
}

/** This category's id plus the ids of every category below it, at any depth. */
export function selfAndDescendantIds(index: CategoryIndex, id: string): Set<string> {
  const ids = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (ids.has(current)) continue;
    ids.add(current);
    for (const child of index.childrenOf.get(current) ?? []) stack.push(child.id);
  }
  return ids;
}

/** Ids of every effectively-on category. Used by the app catalog (T6). */
export function effectivelyActiveIds(index: CategoryIndex): Set<string> {
  const ids = new Set<string>();
  const walk = (parentId: string | null) => {
    for (const node of index.childrenOf.get(parentId) ?? []) {
      if (!node.active) continue; // everything below an off category is off too
      ids.add(node.id);
      walk(node.id);
    }
  };
  walk(null);
  return ids;
}

/** "Plywood › Marine › BWP" style path, top-level first, including the category itself. */
export function pathOf(index: CategoryIndex, id: string): { id: string; name: string }[] {
  const node = index.byId.get(id);
  return [...ancestorsOf(index, id), ...(node ? [node] : [])].map(({ id: nodeId, name }) => ({
    id: nodeId,
    name,
  }));
}

import { z } from "zod";

// Every list endpoint is paginated (rule R13). One sort field per request (DEC-028).
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

type SortDirection = "asc" | "desc";

/** A sort value from the query string: "name" = A→Z / oldest first, "-name" = reverse. */
export type SortValue<F extends string> = F | `-${F}`;

/**
 * Zod rules for `?page`, `?limit` and `?sort` on a list endpoint.
 * Only the given `sortFields` can be sorted on; anything else is a 400.
 * Add the list's own filters with `.extend({...})`.
 *
 *   query: listQuery({ sortFields: ["name", "createdAt"], defaultSort: "-createdAt" })
 *     .extend({ status: z.enum(["active", "inactive"]).optional() })
 */
export function listQuery<const F extends string>(options: {
  sortFields: readonly [F, ...F[]];
  defaultSort: SortValue<F>;
}) {
  const allowedSorts = options.sortFields.flatMap((field) => [field, `-${field}` as const]) as [
    SortValue<F>,
    ...SortValue<F>[],
  ];

  // Typed as plain SortValue<F> so the default can be set while F is still generic.
  const sort = z.enum(allowedSorts) as unknown as z.ZodType<SortValue<F>>;

  return z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    sort: sort.default(options.defaultSort),
  });
}

/** Which rows to fetch: page 2 with limit 20 skips 20 and takes 20. */
export function toPrismaPaging(page: number, limit: number): { skip: number; take: number } {
  return { skip: (page - 1) * limit, take: limit };
}

/**
 * Turns "-createdAt" into Prisma's orderBy, plus a tie-breaker (the id by default)
 * so rows with equal values keep a stable order and never repeat or vanish across pages.
 */
export function toPrismaOrderBy<F extends string, T extends string = "id">(
  sort: SortValue<F>,
  tieBreaker: T = "id" as T
): Partial<Record<F | T, SortDirection>>[] {
  const direction: SortDirection = sort.startsWith("-") ? "desc" : "asc";
  const field = (direction === "desc" ? sort.slice(1) : sort) as F;

  const orderBy = [{ [field]: direction }];
  if ((field as string) !== tieBreaker) orderBy.push({ [tieBreaker]: direction });
  return orderBy as Partial<Record<F | T, SortDirection>>[];
}

/** The `meta` part of a list reply. Asking past the last page gives an empty list, not an error. */
export type PageMeta = { page: number; limit: number; total: number; totalPages: number };

export function pageMeta(page: number, limit: number, total: number): PageMeta {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

// Page with a real total — for small, bounded tables (e.g. products) where a
// COUNT is cheap. Unbounded append-only tables (orders history, audit logs)
// deliberately keep the cheaper `{ items, hasMore }` shape instead.
export interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export function buildPaginated<T>(
  items: T[],
  page: number,
  limit: number,
  total: number,
): Paginated<T> {
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  return { items, page, limit, total, totalPages, hasMore: page < totalPages };
}

// Escapes LIKE/ILIKE wildcards so user-typed `%`, `_` and `\` match
// literally instead of acting as patterns (Postgres' default escape
// character for LIKE is the backslash).
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

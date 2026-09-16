import { z } from "zod";

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type PaginationQuery = z.infer<typeof paginationQuery>;

export function paginate(q: PaginationQuery) {
  return { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
}

export function pageMeta(q: PaginationQuery, total: number) {
  return { page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) };
}

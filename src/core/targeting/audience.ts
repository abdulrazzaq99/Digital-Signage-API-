import { z } from "zod";
import { prisma } from "../db/prisma.js";
import type { TenantScope } from "../auth/scope.js";
import { ValidationError } from "../errors/AppError.js";
import { id, list } from "../validation/fields.js";

/**
 * Who a piece of Head Office content (offer, template, campaign) is for: every location, the
 * locations in chosen categories (Kiosk, Restaurant, ...), or chosen locations. Stored as JSON in
 * an `audience` column.
 */
export const targetAudience = z
  .union([
    z.object({ kind: z.literal("all") }),
    z.object({ kind: z.literal("categories"), categoryIds: z.array(z.string()).min(1) }),
    z.object({ kind: z.literal("companies"), companyIds: z.array(z.string()).min(1) }),
  ])
  .openapi("TargetAudience");
export type TargetAudience = z.infer<typeof targetAudience>;

/** Request form: ids checked, at most 100 categories or 1000 locations. */
export const targetAudienceInput = z.union([
  z.object({ kind: z.literal("all") }).strict(),
  z.object({ kind: z.literal("categories"), categoryIds: list(id(), 100, 1) }).strict(),
  z.object({ kind: z.literal("companies"), companyIds: list(id(), 1000, 1) }).strict(),
]);

export const EVERYONE: TargetAudience = { kind: "all" };

/** Reads a stored audience, treating anything unexpected as "everyone" (the column's default). */
export function audienceOf(value: unknown): TargetAudience {
  const parsed = targetAudience.safeParse(value);
  return parsed.success ? parsed.data : EVERYONE;
}

/** Every category or location named must exist; a typo would otherwise silently reach nobody. */
export async function assertAudienceExists(audience: TargetAudience, path = "body.audience"): Promise<void> {
  if (audience.kind === "all") return;
  const ids = audience.kind === "categories" ? audience.categoryIds : audience.companyIds;
  const found = new Set(
    audience.kind === "categories"
      ? (await prisma.locationCategory.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((c) => c.id)
      : (await prisma.company.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((c) => c.id),
  );
  const field = audience.kind === "categories" ? "categoryIds" : "companyIds";
  const issues = ids.flatMap((v, i) => (found.has(v) ? [] : [{ path: `${path}.${field}.${i}`, message: audience.kind === "categories" ? "Category not found" : "Location not found" }]));
  if (issues.length) throw new ValidationError("Audience contains unknown recipients", issues, "AUDIENCE_NOT_FOUND");
}

/** The location a request is made for, with its category; null for the Super Admin's platform view. */
export interface Viewer {
  companyId: string;
  categoryId: string | null;
}

export async function viewerOf(scope: TenantScope): Promise<Viewer | null> {
  if (scope.kind === "platform") return null;
  const c = await prisma.company.findUnique({ where: { id: scope.companyId }, select: { categoryId: true } });
  return { companyId: scope.companyId, categoryId: c?.categoryId ?? null };
}

/**
 * Prisma filter on a model's `audience` JSON column that keeps rows meant for this location. Works
 * for any model with that column, so it is typed loosely and spread into the model's where.
 */
export function audienceWhere(viewer: Viewer) {
  const kind = (k: string) => ({ audience: { path: ["kind"], equals: k } });
  return {
    OR: [
      kind("all"),
      ...(viewer.categoryId ? [{ AND: [kind("categories"), { audience: { path: ["categoryIds"], array_contains: [viewer.categoryId] } }] }] : []),
      { AND: [kind("companies"), { audience: { path: ["companyIds"], array_contains: [viewer.companyId] } }] },
    ],
  };
}

/** Same rule in code, for a single row already loaded. */
export function isFor(audience: TargetAudience, viewer: Viewer): boolean {
  if (audience.kind === "all") return true;
  if (audience.kind === "categories") return !!viewer.categoryId && audience.categoryIds.includes(viewer.categoryId);
  return audience.companyIds.includes(viewer.companyId);
}

/** Companies an audience reaches, for delivering notifications. */
export async function companiesIn(audience: TargetAudience): Promise<string[] | "all"> {
  if (audience.kind === "all") return "all";
  if (audience.kind === "companies") return audience.companyIds;
  return (await prisma.company.findMany({ where: { categoryId: { in: audience.categoryIds } }, select: { id: true } })).map((c) => c.id);
}

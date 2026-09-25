import { prisma } from "../db/prisma.js";
import type { Tx } from "../db/transaction.js";
import { ConflictError } from "../errors/AppError.js";

/**
 * Names people pick things by must not collide, compared trimmed and case-insensitively: per company
 * for tenant content, globally for companies and the Super Admin's campaigns and offers.
 */
const NAMED = {
  playlist: { table: "Playlist", column: "name", perCompany: true, label: "A playlist with this name already exists" },
  layout: { table: "Layout", column: "name", perCompany: true, label: "A layout with this name already exists" },
  canvas: { table: "CanvasSet", column: "name", perCompany: true, label: "A canvas with this name already exists" },
  screenGroup: { table: "ScreenGroup", column: "name", perCompany: true, label: "A screen group with this name already exists" },
  templateInstance: { table: "TemplateInstance", column: "name", perCompany: true, label: "A template with this name already exists" },
  campaign: { table: "ScratchCampaign", column: "title", perCompany: false, label: "A campaign with this title already exists" },
  offer: { table: "Offer", column: "title", perCompany: false, label: "An offer with this title already exists" },
  company: { table: "Company", column: "name", perCompany: false, label: "A company with this name already exists" },
} as const;

export type NamedKind = keyof typeof NAMED;

/** Whether `name` is taken (trimmed, case-insensitive), ignoring `excludeId` (the row being renamed). */
export async function nameTaken(kind: NamedKind, name: string, opts: { companyId?: string; excludeId?: string; db?: Tx } = {}): Promise<boolean> {
  const { table, column, perCompany } = NAMED[kind];
  const params: unknown[] = [name];
  const where = [`lower(btrim("${column}")) = lower(btrim($1))`];
  if (perCompany) {
    params.push(opts.companyId);
    where.push(`"companyId" = $${params.length}`);
  }
  if (kind === "layout") where.push(`"isPreset" = false`);
  if (opts.excludeId) {
    params.push(opts.excludeId);
    where.push(`"id" <> $${params.length}`);
  }
  // Table and column names come from the fixed map above; only values are parameters.
  const rows = await (opts.db ?? prisma).$queryRawUnsafe<{ id: string }[]>(`SELECT "id" FROM "${table}" WHERE ${where.join(" AND ")} LIMIT 1`, ...params);
  return rows.length > 0;
}

/** 409 DUPLICATE with a field error on `body.name` (or `body.title`) when the name is taken. */
export async function assertNameFree(kind: NamedKind, name: string | undefined, opts: { companyId?: string; excludeId?: string; db?: Tx } = {}): Promise<void> {
  if (name === undefined) return;
  if (!(await nameTaken(kind, name, opts))) return;
  const { column, label } = NAMED[kind];
  throw new ConflictError(label, "DUPLICATE", [{ path: `body.${column}`, message: label }]);
}

/** "Menu (copy)", then "Menu (copy 2)", "Menu (copy 3)"… whichever is free first. */
export async function freeCopyName(kind: NamedKind, base: string, opts: { companyId?: string; db?: Tx; maxLength?: number } = {}): Promise<string> {
  const max = opts.maxLength ?? 120;
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? " (copy)" : ` (copy ${n})`;
    const candidate = `${base.trim().slice(0, max - suffix.length)}${suffix}`;
    if (!(await nameTaken(kind, candidate, opts))) return candidate;
  }
  throw new ConflictError("Could not find a free name for the copy; rename some copies first", "DUPLICATE");
}

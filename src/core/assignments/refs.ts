import { prisma } from "../db/prisma.js";
import type { Tx } from "../db/transaction.js";
import { ValidationError } from "../errors/AppError.js";
import type { AssignmentKind } from "../../generated/prisma/enums.js";

/**
 * Checks for IDs and storage keys a client hands us. An ID from another company is reported the
 * same way as one that does not exist, so a caller can't probe other tenants.
 */

const LABEL: Record<AssignmentKind, string> = { PLAYLIST: "Playlist", LAYOUT: "Layout", TEMPLATE_INSTANCE: "Template instance", CANVAS: "Canvas" };

/** A playlist, company layout or template instance of the company (the things a canvas can show). */
export async function assertContentInCompany(companyId: string, kind: AssignmentKind, refId: string, path: string, db: Tx = prisma): Promise<void> {
  const found =
    kind === "PLAYLIST" ? await db.playlist.count({ where: { id: refId, companyId } })
    : kind === "LAYOUT" ? await db.layout.count({ where: { id: refId, companyId, isPreset: false } })
    : kind === "TEMPLATE_INSTANCE" ? await db.templateInstance.count({ where: { id: refId, companyId } })
    : 0;
  if (!found) throw new ValidationError(`${LABEL[kind]} not found`, [{ path, message: `${LABEL[kind]} not found` }], "CONTENT_NOT_FOUND");
}

/**
 * A storage key picked for campaign artwork or an offer image must be a READY image in the media
 * library, so nobody can presign an arbitrary object in the bucket. `companyId` narrows it to one
 * tenant when the caller targets one; platform content (campaigns, offers) may use any company's image.
 */
export async function assertImageKey(key: string, companyId: string | undefined, path: string): Promise<void> {
  const found = await prisma.mediaAsset.count({ where: { storageKey: key, type: "IMAGE", status: "READY", ...(companyId ? { companyId } : {}) } });
  if (!found) throw new ValidationError("Choose a ready image from the media library", [{ path, message: "Choose a ready image from the media library" }], "MEDIA_KEY_INVALID");
}

/** Every ID in `groupIds` is a screen group of the company. */
export async function assertGroupsInCompany(companyId: string, groupIds: string[], path: string, db: Tx = prisma): Promise<void> {
  const unique = [...new Set(groupIds)];
  if (!unique.length) return;
  const found = new Set((await db.screenGroup.findMany({ where: { id: { in: unique }, companyId }, select: { id: true } })).map((g) => g.id));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length) throw new ValidationError("One or more screen groups were not found", missing.map(() => ({ path, message: "Screen group not found" })), "GROUP_NOT_FOUND");
}

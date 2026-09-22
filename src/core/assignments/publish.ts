import { logActivity } from "../audit/activity.js";
import type { AuthUser } from "../auth/scope.js";
import { withTransaction, type Tx } from "../db/transaction.js";
import { ForbiddenError, ValidationError } from "../errors/AppError.js";
import { Events } from "../realtime/events.js";
import { emitToCompany, emitToScreen } from "../realtime/server.js";
import type { AssignmentKind } from "../../generated/prisma/enums.js";

export interface PublishTarget {
  screenIds?: string[];
  groupIds?: string[];
}

export interface PublishResult {
  screens: { id: string; name: string; status: string; version: number }[];
  version: number;
}

/**
 * Shared publish routine used by playlists, layouts, templates, and canvas: resolves targets to
 * screens, checks the licence, bumps each screen's manifest version, upserts the desired
 * assignment, emits `screen.assignment.updated`, and writes one activity entry.
 */
export async function publishAssignment(input: { actor: AuthUser; companyId: string; kind: AssignmentKind; refId: string; refName: string; target: PublishTarget; activateAt?: Date | null; tx?: Tx }): Promise<PublishResult> {
  const run = async (tx: Tx): Promise<PublishResult> => {
    const license = await tx.license.findUnique({ where: { companyId: input.companyId } });
    if (!license || license.state !== "ACTIVE") throw new ForbiddenError(`Publishing is blocked while the licence is ${license?.state.toLowerCase() ?? "missing"}`, "LICENSE_SUSPENDED");

    const groupScreenIds = input.target.groupIds?.length
      ? (await tx.screenGroupMember.findMany({ where: { groupId: { in: input.target.groupIds }, group: { companyId: input.companyId } }, select: { screenId: true } })).map((m) => m.screenId)
      : [];
    const ids = [...new Set([...(input.target.screenIds ?? []), ...groupScreenIds])];
    if (!ids.length) throw new ValidationError("Select at least one screen or group", undefined, "NO_TARGET");
    const screens = await tx.screen.findMany({ where: { id: { in: ids }, companyId: input.companyId, pairingStatus: "PAIRED" }, select: { id: true, name: true, status: true, manifestVersion: true } });
    if (screens.length !== ids.length) throw new ValidationError("One or more target screens were not found", undefined, "SCREEN_NOT_FOUND");

    // Canvas members report ready again once they have preloaded the new version.
    await tx.canvasMember.updateMany({ where: { screenId: { in: ids } }, data: { ready: false } });
    const results: PublishResult["screens"] = [];
    for (const s of screens) {
      const version = s.manifestVersion + 1;
      await tx.screen.update({ where: { id: s.id }, data: { manifestVersion: version, syncState: "PENDING" } });
      await tx.screenAssignment.upsert({ where: { screenId: s.id }, update: { kind: input.kind, refId: input.refId, version, activateAt: input.activateAt ?? null, publishedAt: new Date(), publishedById: input.actor.id }, create: { screenId: s.id, kind: input.kind, refId: input.refId, version, activateAt: input.activateAt ?? null, publishedById: input.actor.id } });
      results.push({ id: s.id, name: s.name, status: s.status, version });
    }
    await logActivity({ companyId: input.companyId, actor: input.actor, action: `${input.kind.toLowerCase()}.published`, resourceType: input.kind.toLowerCase(), resourceId: input.refId, summary: `"${input.refName}" published to ${screens.length} screen${screens.length > 1 ? "s" : ""}`, meta: { screenIds: ids } }, tx);
    return { screens: results, version: Math.max(...results.map((r) => r.version)) };
  };
  if (input.tx) {
    // Inside a caller's transaction: the caller must call emitAssignmentUpdated after it commits,
    // otherwise a fast player fetches the manifest before the new version is visible.
    return run(input.tx);
  }
  const result = await withTransaction(run);
  emitAssignmentUpdated(input, result);
  return result;
}

/** Notifies players and dashboards about a publish. Call only after the writes are committed. */
export function emitAssignmentUpdated(input: { companyId: string; kind: AssignmentKind; refId: string; activateAt?: Date | null }, result: PublishResult): void {
  for (const s of result.screens) emitToScreen(s.id, Events.assignmentUpdated, { screenId: s.id, version: s.version, kind: input.kind, refId: input.refId, activateAt: input.activateAt?.toISOString() ?? null });
  emitToCompany(input.companyId, Events.assignmentUpdated, { kind: input.kind, refId: input.refId, screenIds: result.screens.map((s) => s.id) });
}

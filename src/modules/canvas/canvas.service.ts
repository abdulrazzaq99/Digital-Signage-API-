import type { z } from "zod";
import { CANVAS_ACTIVATE_DELAY_MS } from "../../config/constants.js";
import { publishAssignment } from "../../core/assignments/publish.js";
import { logActivity } from "../../core/audit/activity.js";
import { requireCompanyId, type AuthUser, type TenantScope } from "../../core/auth/scope.js";
import { prisma } from "../../core/db/prisma.js";
import { withTransaction } from "../../core/db/transaction.js";
import { ConflictError, NotFoundError, ValidationError } from "../../core/errors/AppError.js";
import { Events } from "../../core/realtime/events.js";
import { emitToCompany, emitToScreen } from "../../core/realtime/server.js";
import { onlineSet } from "../../core/redis/presence.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { createCanvasBody, updateCanvasBody } from "./canvas.schemas.js";

const include = { members: { orderBy: { position: "asc" as const }, include: { screen: { select: { id: true, name: true, location: true, status: true, orientation: true, ackVersion: true, manifestVersion: true } } } } } satisfies Prisma.CanvasSetInclude;
type CanvasRow = Prisma.CanvasSetGetPayload<{ include: typeof include }>;

async function toDto(c: CanvasRow) {
  const online = await onlineSet(c.members.map((m) => m.screenId));
  const members = c.members.map((m) => ({ screenId: m.screenId, name: m.screen.name, location: m.screen.location, position: m.position, status: m.screen.status, orientation: m.screen.orientation, ready: online.has(m.screenId), synced: m.screen.ackVersion >= m.screen.manifestVersion }));
  const readyCount = members.filter((m) => m.ready).length;
  const status = c.status === "ACTIVE" && readyCount < members.length ? "DEGRADED" : c.status;
  return { id: c.id, name: c.name, status, members, readyCount, content: c.contentKind && c.contentRef ? { kind: c.contentKind, refId: c.contentRef } : null, activateAt: c.activateAt?.toISOString() ?? null, createdAt: c.createdAt.toISOString() };
}

async function findScoped(companyId: string, id: string) {
  const c = await prisma.canvasSet.findFirst({ where: { id, companyId }, include });
  if (!c) throw new NotFoundError("Canvas");
  return c;
}

/** Members must belong to the company, be paired, share one orientation, and not already sit in another set. */
async function validateMembers(companyId: string, screenIds: string[], excludeSetId?: string) {
  if (new Set(screenIds).size !== screenIds.length) throw new ValidationError("Duplicate screens in canvas", undefined, "DUPLICATE_SCREEN");
  const screens = await prisma.screen.findMany({ where: { id: { in: screenIds }, companyId, pairingStatus: "PAIRED" }, select: { id: true, orientation: true, canvasMember: { select: { setId: true } } } });
  if (screens.length !== screenIds.length) throw new ValidationError("One or more screens were not found", undefined, "SCREEN_NOT_FOUND");
  if (new Set(screens.map((s) => s.orientation)).size > 1) throw new ValidationError("All screens in a canvas must share the same orientation", undefined, "ORIENTATION_MISMATCH");
  const taken = screens.filter((s) => s.canvasMember && s.canvasMember.setId !== excludeSetId);
  if (taken.length) throw new ConflictError("One or more screens already belong to another canvas", "SCREEN_IN_CANVAS", { screenIds: taken.map((s) => s.id) });
}

export const canvasService = {
  async list(scope: TenantScope) {
    return Promise.all((await prisma.canvasSet.findMany({ where: { companyId: requireCompanyId(scope) }, include, orderBy: { createdAt: "desc" } })).map(toDto));
  },
  async get(scope: TenantScope, id: string) {
    return toDto(await findScoped(requireCompanyId(scope), id));
  },
  async create(actor: AuthUser, scope: TenantScope, body: z.infer<typeof createCanvasBody>) {
    const companyId = requireCompanyId(scope);
    await validateMembers(companyId, body.screenIds);
    const c = await prisma.canvasSet.create({ data: { companyId, name: body.name, members: { create: body.screenIds.map((screenId, position) => ({ screenId, position })) } }, include });
    await logActivity({ companyId, actor, action: "canvas.created", resourceType: "canvas", resourceId: c.id, summary: `Canvas "${c.name}" created with ${body.screenIds.length} screens` });
    return toDto(c);
  },
  async update(actor: AuthUser, scope: TenantScope, id: string, body: z.infer<typeof updateCanvasBody>) {
    const companyId = requireCompanyId(scope);
    await findScoped(companyId, id);
    if (body.screenIds) await validateMembers(companyId, body.screenIds, id);
    const c = await withTransaction(async (tx) => {
      if (body.screenIds) {
        await tx.canvasMember.deleteMany({ where: { setId: id } });
        await tx.canvasMember.createMany({ data: body.screenIds.map((screenId, position) => ({ setId: id, screenId, position })) });
      }
      return tx.canvasSet.update({ where: { id }, data: { name: body.name, ...(body.content !== undefined ? { contentKind: body.content?.kind ?? null, contentRef: body.content?.refId ?? null } : {}), ...(body.screenIds || body.content !== undefined ? { status: "DRAFT", activateAt: null } : {}) }, include });
    });
    await logActivity({ companyId, actor, action: "canvas.updated", resourceType: "canvas", resourceId: id, summary: `Canvas "${c.name}" reconfigured`, meta: { fields: Object.keys(body) } });
    return toDto(c);
  },
  /** All members must be online and synced; activation publishes the content with a shared future activate_at (spec 9.1 step 7). */
  async activate(actor: AuthUser, scope: TenantScope, id: string) {
    const companyId = requireCompanyId(scope);
    const c = await findScoped(companyId, id);
    if (!c.contentKind || !c.contentRef) throw new ValidationError("Assign content to the canvas before activating", undefined, "NO_CONTENT");
    const dto = await toDto(c);
    if (dto.readyCount < dto.members.length) throw new ConflictError(`${dto.members.length - dto.readyCount} of ${dto.members.length} screens are not ready`, "CANVAS_DEGRADED", { members: dto.members.filter((m) => !m.ready).map((m) => m.name) });
    const activateAt = new Date(Date.now() + CANVAS_ACTIVATE_DELAY_MS);
    await publishAssignment({ actor, companyId, kind: "CANVAS", refId: id, refName: c.name, target: { screenIds: c.members.map((m) => m.screenId) }, activateAt });
    const updated = await prisma.canvasSet.update({ where: { id }, data: { status: "ACTIVE", activateAt }, include });
    for (const m of c.members) emitToScreen(m.screenId, Events.canvasActivate, { setId: id, position: m.position, total: c.members.length, activateAt: activateAt.toISOString(), content: { kind: c.contentKind, refId: c.contentRef } });
    emitToCompany(companyId, Events.canvasActivate, { setId: id, activateAt: activateAt.toISOString() });
    return toDto(updated);
  },
  async deactivate(actor: AuthUser, scope: TenantScope, id: string) {
    const companyId = requireCompanyId(scope);
    const c = await findScoped(companyId, id);
    const updated = await prisma.canvasSet.update({ where: { id }, data: { status: "INACTIVE", activateAt: null }, include });
    await prisma.screenAssignment.deleteMany({ where: { kind: "CANVAS", refId: id } });
    for (const m of c.members) emitToScreen(m.screenId, Events.remoteRefresh, { reason: "canvas_deactivated" });
    await logActivity({ companyId, actor, action: "canvas.deactivated", resourceType: "canvas", resourceId: id, summary: `Canvas "${c.name}" deactivated` });
    return toDto(updated);
  },
  async remove(actor: AuthUser, scope: TenantScope, id: string) {
    const companyId = requireCompanyId(scope);
    const c = await findScoped(companyId, id);
    if (c.status === "ACTIVE") throw new ConflictError("Deactivate the canvas before deleting it", "CANVAS_ACTIVE");
    await prisma.canvasSet.delete({ where: { id } });
    await logActivity({ companyId, actor, action: "canvas.deleted", resourceType: "canvas", resourceId: id, summary: `Canvas "${c.name}" deleted` });
  },
};

import type { z } from "zod";
import { logActivity } from "../../core/audit/activity.js";
import type { AuthUser, TenantScope } from "../../core/auth/scope.js";
import { withTransaction } from "../../core/db/transaction.js";
import { ForbiddenError, NotFoundError } from "../../core/errors/AppError.js";
import type { License } from "../../generated/prisma/client.js";
import { licensesRepository as repo } from "./licenses.repository.js";
import type { updateLicenseBody } from "./licenses.schemas.js";

function toDto(l: License, paired: number) {
  return { companyId: l.companyId, screenLimit: l.screenLimit, state: l.state, overLimit: l.overLimit, paired, available: Math.max(0, l.screenLimit - paired), expiresAt: l.expiresAt?.toISOString() ?? null, updatedAt: l.updatedAt.toISOString() };
}

export const licensesService = {
  async listAll() {
    const rows = await repo.listAll();
    return Promise.all(rows.map(async (l) => ({ ...toDto(l, await repo.pairedCount(l.companyId)), company: l.company })));
  },

  async get(scope: TenantScope, companyId: string) {
    if (scope.kind === "company" && scope.companyId !== companyId) throw new NotFoundError("License");
    const l = await repo.findByCompany(companyId);
    if (!l) throw new NotFoundError("License");
    return toDto(l, await repo.pairedCount(companyId));
  },

  /**
   * Super Admin only. Lowering the limit below the paired count never deletes screens:
   * the license is flagged over-limit and an activity entry is written for resolution.
   */
  async update(actor: AuthUser, companyId: string, body: z.infer<typeof updateLicenseBody>) {
    return withTransaction(async (tx) => {
      const locked = await repo.lockByCompany(companyId, tx);
      if (!locked) throw new NotFoundError("License");
      const paired = await repo.pairedCount(companyId, tx);
      const newLimit = body.screenLimit ?? locked.screenLimit;
      const overLimit = paired > newLimit;
      const updated = await repo.update(companyId, { screenLimit: newLimit, state: body.state, expiresAt: body.expiresAt === undefined ? undefined : body.expiresAt ? new Date(body.expiresAt) : null, overLimit, company: { update: { overLimit } } }, tx);
      const changes: string[] = [];
      if (body.screenLimit !== undefined && body.screenLimit !== locked.screenLimit) changes.push(`screen limit ${locked.screenLimit} → ${body.screenLimit}`);
      if (body.state && body.state !== locked.state) changes.push(`state ${locked.state} → ${body.state}`);
      await logActivity({ companyId, actor, action: "license.updated", resourceType: "license", resourceId: updated.id, status: overLimit ? "PENDING" : "SUCCESS", summary: overLimit ? `License limit set below paired screens (${paired} paired, limit ${newLimit}); account flagged for resolution` : `License updated: ${changes.join(", ") || "no changes"}`, meta: { paired, newLimit, overLimit, changes } }, tx);
      return toDto(updated, paired);
    });
  },

  assertPlatform(scope: TenantScope) {
    if (scope.kind !== "platform") throw new ForbiddenError("Super Admin access required", "PLATFORM_ONLY");
  },
};

import type { z } from "zod";
import { publishAssignment } from "../../core/assignments/publish.js";
import { logActivity } from "../../core/audit/activity.js";
import { requireCompanyId, type AuthUser, type TenantScope } from "../../core/auth/scope.js";
import { prisma } from "../../core/db/prisma.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../core/errors/AppError.js";
import { enqueue, JobNames } from "../../core/queue/queues.js";
import { presignGet } from "../../core/storage/s3.js";
import type { Template, TemplateInstance } from "../../generated/prisma/client.js";
import { templateField, type TemplateField, type createInstanceBody, type createTemplateBody, type updateInstanceBody } from "./templates.schemas.js";
import type { publishBody } from "../playlists/playlists.schemas.js";

function fieldsOf(t: Template): TemplateField[] {
  return (t.fields as unknown[]).map((f) => templateField.parse(f));
}

/** Enforces the template's field constraints: unknown keys rejected, required present, max length. */
export function validateValues(fields: TemplateField[], values: Record<string, string>): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const known = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(values)) if (!known.has(key)) issues.push({ path: key, message: "Field is not editable in this template" });
  for (const f of fields) {
    const v = values[f.key]?.trim() ?? "";
    if (f.required && !v) issues.push({ path: f.key, message: `${f.label} is required` });
    if (f.max && v.length > f.max) issues.push({ path: f.key, message: `${f.label} must be at most ${f.max} characters` });
    if (f.type === "color" && v && !/^#[0-9a-fA-F]{6}$/.test(v)) issues.push({ path: f.key, message: `${f.label} must be a hex colour like #2563EB` });
  }
  return issues;
}

async function toTemplateDto(t: Template) {
  return { id: t.id, name: t.name, category: t.category, orientation: t.orientation, fields: fieldsOf(t), isGlobal: t.isGlobal, usedIn: await prisma.templateInstance.count({ where: { templateId: t.id } }), createdAt: t.createdAt.toISOString() };
}

async function toInstanceDto(i: TemplateInstance & { template: { name: string } }) {
  return { id: i.id, templateId: i.templateId, templateName: i.template.name, name: i.name, values: i.values as Record<string, string>, outputUrl: i.outputKey ? await presignGet(i.outputKey) : null, rendered: !!i.outputKey, createdAt: i.createdAt.toISOString(), updatedAt: i.updatedAt.toISOString() };
}

async function findInstance(companyId: string, id: string) {
  const i = await prisma.templateInstance.findFirst({ where: { id, companyId }, include: { template: true } });
  if (!i) throw new NotFoundError("Template instance");
  return i;
}

export const templatesService = {
  async list() {
    return Promise.all((await prisma.template.findMany({ where: { isGlobal: true }, orderBy: { name: "asc" } })).map(toTemplateDto));
  },

  /** Templates are designer deliverables; only the Super Admin defines them. */
  async create(actor: AuthUser, scope: TenantScope, body: z.infer<typeof createTemplateBody>) {
    if (scope.kind !== "platform") throw new ForbiddenError("Only the Super Admin can define templates", "PLATFORM_ONLY");
    const keys = body.fields.map((f) => f.key);
    if (new Set(keys).size !== keys.length) throw new ValidationError("Field keys must be unique", undefined, "DUPLICATE_FIELD");
    const t = await prisma.template.create({ data: { name: body.name, category: body.category, orientation: body.orientation, fields: body.fields, isGlobal: true } });
    await logActivity({ actor, action: "template.created", resourceType: "template", resourceId: t.id, summary: `Template "${t.name}" created` });
    return toTemplateDto(t);
  },

  async remove(actor: AuthUser, scope: TenantScope, id: string) {
    if (scope.kind !== "platform") throw new ForbiddenError("Only the Super Admin can delete templates", "PLATFORM_ONLY");
    const t = await prisma.template.findUnique({ where: { id } });
    if (!t) throw new NotFoundError("Template");
    const used = await prisma.templateInstance.count({ where: { templateId: id } });
    if (used) throw new ConflictError(`Template is used by ${used} instance${used > 1 ? "s" : ""}`, "TEMPLATE_IN_USE");
    await prisma.template.delete({ where: { id } });
    await logActivity({ actor, action: "template.deleted", resourceType: "template", resourceId: id, summary: `Template "${t.name}" deleted` });
  },

  async listInstances(scope: TenantScope) {
    return Promise.all((await prisma.templateInstance.findMany({ where: { companyId: requireCompanyId(scope) }, include: { template: true }, orderBy: { updatedAt: "desc" } })).map(toInstanceDto));
  },

  async getInstance(scope: TenantScope, id: string) {
    return toInstanceDto(await findInstance(requireCompanyId(scope), id));
  },

  async createInstance(actor: AuthUser, scope: TenantScope, body: z.infer<typeof createInstanceBody>) {
    const companyId = requireCompanyId(scope);
    const t = await prisma.template.findUnique({ where: { id: body.templateId } });
    if (!t) throw new ValidationError("Template not found", undefined, "TEMPLATE_NOT_FOUND");
    const issues = validateValues(fieldsOf(t), body.values);
    if (issues.length) throw new ValidationError("Template values are invalid", issues, "TEMPLATE_VALUES_INVALID");
    const i = await prisma.templateInstance.create({ data: { companyId, templateId: t.id, name: body.name, values: body.values }, include: { template: true } });
    await logActivity({ companyId, actor, action: "template_instance.created", resourceType: "template_instance", resourceId: i.id, summary: `"${i.name}" created from template ${t.name}` });
    return toInstanceDto(i);
  },

  async updateInstance(actor: AuthUser, scope: TenantScope, id: string, body: z.infer<typeof updateInstanceBody>) {
    const companyId = requireCompanyId(scope);
    const existing = await findInstance(companyId, id);
    if (body.values) {
      const issues = validateValues(fieldsOf(existing.template), body.values);
      if (issues.length) throw new ValidationError("Template values are invalid", issues, "TEMPLATE_VALUES_INVALID");
    }
    const i = await prisma.templateInstance.update({ where: { id }, data: { name: body.name, values: body.values, ...(body.values ? { outputKey: null } : {}) }, include: { template: true } });
    return toInstanceDto(i);
  },

  async render(scope: TenantScope, id: string) {
    const companyId = requireCompanyId(scope);
    const i = await findInstance(companyId, id);
    await enqueue(JobNames.templateRender, { instanceId: i.id, companyId });
    return toInstanceDto(i);
  },

  async publish(actor: AuthUser, scope: TenantScope, id: string, body: z.infer<typeof publishBody>) {
    const companyId = requireCompanyId(scope);
    const i = await findInstance(companyId, id);
    if (!i.outputKey) throw new ValidationError("Render the template before publishing", undefined, "NOT_RENDERED");
    return publishAssignment({ actor, companyId, kind: "TEMPLATE_INSTANCE", refId: id, refName: i.name, target: body });
  },

  async removeInstance(actor: AuthUser, scope: TenantScope, id: string) {
    const companyId = requireCompanyId(scope);
    const i = await findInstance(companyId, id);
    const assigned = await prisma.screenAssignment.count({ where: { kind: "TEMPLATE_INSTANCE", refId: id } });
    if (assigned) throw new ConflictError(`Template output is live on ${assigned} screen${assigned > 1 ? "s" : ""}`, "TEMPLATE_INSTANCE_IN_USE");
    await prisma.templateInstance.delete({ where: { id } });
    await logActivity({ companyId, actor, action: "template_instance.deleted", resourceType: "template_instance", resourceId: id, summary: `"${i.name}" deleted` });
  },
};

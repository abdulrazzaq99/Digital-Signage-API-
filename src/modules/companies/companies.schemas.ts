import { z } from "zod";
import { paginationQuery } from "../../core/http/pagination.js";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";
import { clearableField, clearableText, id, int, optionalField, optionalText, phone, text, timezone, url } from "../../core/validation/fields.js";

export const companyStatus = z.enum(["ACTIVE", "INACTIVE", "SUSPENDED"]);
export const licenseState = z.enum(["ACTIVE", "SUSPENDED", "DISABLED", "EXPIRED"]);

export const listCompaniesQuery = paginationQuery.extend({ search: optionalText(100), status: companyStatus.optional() });
export const companyIdParams = z.object({ id: id() });
export const createCompanyBody = z.object({
  name: text(120, 2),
  status: companyStatus.default("ACTIVE"),
  website: optionalField(url(300)),
  industry: optionalText(80),
  phone: optionalField(phone()),
  timezone: timezone().default("UTC"),
  plan: optionalText(80),
  screenLimit: int(1, 10_000),
  licenseState: licenseState.default("ACTIVE"),
}).openapi("CreateCompanyBody");
/** Blank or null clears website, industry, phone and plan. */
export const updateCompanyBody = z.object({
  name: text(120, 2).optional(),
  status: companyStatus.optional(),
  website: clearableField(url(300)),
  industry: clearableText(80),
  phone: clearableField(phone()),
  timezone: timezone().optional(),
  plan: clearableText(80),
}).openapi("UpdateCompanyBody");

export const companyDto = z.object({
  id: z.string(), code: z.string(), name: z.string(), status: companyStatus, website: z.string().nullable(), industry: z.string().nullable(), phone: z.string().nullable(), timezone: z.string(), plan: z.string().nullable(), overLimit: z.boolean(), createdAt: z.string(),
  license: z.object({ screenLimit: z.number(), state: licenseState, overLimit: z.boolean() }).nullable(),
  counts: z.object({ screens: z.number(), online: z.number(), offline: z.number(), available: z.number() }).optional(),
}).openapi("Company");

const tag = ["Companies"];
const sec = [{ bearerAuth: [] }];
registry.registerPath({ method: "get", path: "/companies", tags: tag, security: sec, request: { query: listCompaniesQuery }, responses: { 200: jsonBody(envelope(z.array(companyDto))), 403: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "post", path: "/companies", tags: tag, security: sec, request: { body: jsonBody(createCompanyBody) }, responses: { 201: jsonBody(envelope(companyDto)) } });
registry.registerPath({ method: "get", path: "/companies/{id}", tags: tag, security: sec, request: { params: companyIdParams }, responses: { 200: jsonBody(envelope(companyDto)), 404: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "patch", path: "/companies/{id}", tags: tag, security: sec, request: { params: companyIdParams, body: jsonBody(updateCompanyBody) }, responses: { 200: jsonBody(envelope(companyDto)) } });
registry.registerPath({ method: "delete", path: "/companies/{id}", tags: tag, security: sec, request: { params: companyIdParams }, responses: { 204: { description: "Deleted" } } });
registry.registerPath({ method: "get", path: "/companies/{id}/summary", tags: tag, security: sec, request: { params: companyIdParams }, responses: { 200: jsonBody(envelope(companyDto)) } });

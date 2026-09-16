import { z } from "zod";
import { paginationQuery } from "../../core/http/pagination.js";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";

export const companyStatus = z.enum(["ACTIVE", "INACTIVE", "SUSPENDED"]);
export const licenseState = z.enum(["ACTIVE", "SUSPENDED", "DISABLED", "EXPIRED"]);

export const listCompaniesQuery = paginationQuery.extend({ search: z.string().trim().max(100).optional(), status: companyStatus.optional() });
export const companyIdParams = z.object({ id: z.string().min(1) });
export const createCompanyBody = z.object({
  name: z.string().trim().min(2).max(120),
  status: companyStatus.default("ACTIVE"),
  website: z.string().url().optional(),
  industry: z.string().max(80).optional(),
  phone: z.string().max(40).optional(),
  timezone: z.string().max(64).default("UTC"),
  plan: z.string().max(60).optional(),
  screenLimit: z.number().int().min(1).max(10_000),
  licenseState: licenseState.default("ACTIVE"),
}).openapi("CreateCompanyBody");
export const updateCompanyBody = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  status: companyStatus.optional(),
  website: z.string().url().nullable().optional(),
  industry: z.string().max(80).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  timezone: z.string().max(64).optional(),
  plan: z.string().max(60).nullable().optional(),
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

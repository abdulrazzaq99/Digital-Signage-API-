import { z } from "zod";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";
import { licenseState } from "../companies/companies.schemas.js";

export const companyIdParams = z.object({ companyId: z.string().min(1) });
export const updateLicenseBody = z.object({ screenLimit: z.number().int().min(1).max(10_000).optional(), state: licenseState.optional(), expiresAt: z.string().datetime().nullable().optional() }).refine((b) => Object.keys(b).length > 0, "Nothing to update").openapi("UpdateLicenseBody");
export const licenseDto = z.object({ companyId: z.string(), screenLimit: z.number(), state: licenseState, overLimit: z.boolean(), paired: z.number(), available: z.number(), expiresAt: z.string().nullable(), updatedAt: z.string() }).openapi("License");

const tag = ["Licenses"];
const sec = [{ bearerAuth: [] }];
registry.registerPath({ method: "get", path: "/licenses", tags: tag, security: sec, responses: { 200: jsonBody(envelope(z.array(licenseDto))) } });
registry.registerPath({ method: "get", path: "/companies/{companyId}/license", tags: tag, security: sec, request: { params: companyIdParams }, responses: { 200: jsonBody(envelope(licenseDto)), 404: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "put", path: "/companies/{companyId}/license", tags: tag, security: sec, request: { params: companyIdParams, body: jsonBody(updateLicenseBody) }, responses: { 200: jsonBody(envelope(licenseDto)) } });

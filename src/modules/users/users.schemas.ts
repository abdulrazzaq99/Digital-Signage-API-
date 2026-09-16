import { z } from "zod";
import { paginationQuery } from "../../core/http/pagination.js";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";

export const companyRole = z.enum(["ADMIN", "EDITOR", "VIEWER"]);
export const listUsersQuery = paginationQuery.extend({ search: z.string().trim().max(100).optional() });
export const userIdParams = z.object({ id: z.string().min(1) });
export const createUserBody = z.object({ email: z.string().email().max(160), name: z.string().trim().min(2).max(120), role: companyRole, password: z.string().min(8).max(128).optional(), title: z.string().max(80).optional(), phone: z.string().max(40).optional() }).openapi("CreateUserBody");
export const updateUserBody = z.object({ name: z.string().trim().min(2).max(120).optional(), role: companyRole.optional(), title: z.string().max(80).nullable().optional(), phone: z.string().max(40).nullable().optional(), isActive: z.boolean().optional() }).openapi("UpdateUserBody");
export const updateProfileBody = z.object({ name: z.string().trim().min(2).max(120).optional(), title: z.string().max(80).nullable().optional(), phone: z.string().max(40).nullable().optional() }).openapi("UpdateProfileBody");

export const userDto = z.object({ id: z.string(), email: z.string(), name: z.string(), role: companyRole.nullable(), title: z.string().nullable(), phone: z.string().nullable(), status: z.enum(["ACTIVE", "INVITED", "SUSPENDED"]), lastLoginAt: z.string().nullable(), createdAt: z.string() }).openapi("User");

const tag = ["Users"];
const sec = [{ bearerAuth: [] }];
registry.registerPath({ method: "get", path: "/users", tags: tag, security: sec, request: { query: listUsersQuery }, responses: { 200: jsonBody(envelope(z.array(userDto))) } });
registry.registerPath({ method: "post", path: "/users", tags: tag, security: sec, request: { body: jsonBody(createUserBody) }, responses: { 201: jsonBody(envelope(userDto)), 409: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "patch", path: "/users/{id}", tags: tag, security: sec, request: { params: userIdParams, body: jsonBody(updateUserBody) }, responses: { 200: jsonBody(envelope(userDto)), 404: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "delete", path: "/users/{id}", tags: tag, security: sec, request: { params: userIdParams }, responses: { 204: { description: "Removed" } } });
registry.registerPath({ method: "patch", path: "/users/me", tags: tag, security: sec, request: { body: jsonBody(updateProfileBody) }, responses: { 200: jsonBody(envelope(userDto)) } });

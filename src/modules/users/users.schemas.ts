import { z } from "zod";
import { paginationQuery } from "../../core/http/pagination.js";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";
import { clearableField, clearableText, email, id, optionalField, optionalText, password, phone, text } from "../../core/validation/fields.js";

export const companyRole = z.enum(["ADMIN", "EDITOR", "VIEWER"]);
export const listUsersQuery = paginationQuery.extend({ search: optionalText(100) });
export const userIdParams = z.object({ id: id() });
export const createUserBody = z.object({ email: email(), name: text(120, 2), role: companyRole, password: optionalField(password()), title: optionalText(80), phone: optionalField(phone()) }).openapi("CreateUserBody");
export const updateUserBody = z.object({ name: text(120, 2).optional(), role: companyRole.optional(), title: clearableText(80), phone: clearableField(phone()), isActive: z.boolean().optional() }).openapi("UpdateUserBody");
export const updateProfileBody = z.object({ name: text(120, 2).optional(), title: clearableText(80), phone: clearableField(phone()) }).openapi("UpdateProfileBody");

export const userDto = z.object({ id: z.string(), email: z.string(), name: z.string(), role: companyRole.nullable(), title: z.string().nullable(), phone: z.string().nullable(), status: z.enum(["ACTIVE", "INVITED", "SUSPENDED"]), lastLoginAt: z.string().nullable(), createdAt: z.string() }).openapi("User");

const tag = ["Users"];
const sec = [{ bearerAuth: [] }];
registry.registerPath({ method: "get", path: "/users", tags: tag, security: sec, request: { query: listUsersQuery }, responses: { 200: jsonBody(envelope(z.array(userDto))) } });
registry.registerPath({ method: "post", path: "/users", tags: tag, security: sec, request: { body: jsonBody(createUserBody) }, responses: { 201: jsonBody(envelope(userDto)), 409: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "patch", path: "/users/{id}", tags: tag, security: sec, request: { params: userIdParams, body: jsonBody(updateUserBody) }, responses: { 200: jsonBody(envelope(userDto)), 404: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "delete", path: "/users/{id}", tags: tag, security: sec, request: { params: userIdParams }, responses: { 204: { description: "Removed" } } });
registry.registerPath({ method: "patch", path: "/users/me", tags: tag, security: sec, request: { body: jsonBody(updateProfileBody) }, responses: { 200: jsonBody(envelope(userDto)) } });

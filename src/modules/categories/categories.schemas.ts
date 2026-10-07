import { z } from "zod";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";
import { id, text } from "../../core/validation/fields.js";

export const idParams = z.object({ id: id() });
export const categoryBody = z.object({ name: text(60, 2) }).strict().openapi("CategoryBody");
export const categoryDto = z.object({ id: z.string(), name: z.string(), companies: z.number(), createdAt: z.string() }).openapi("LocationCategory");

const tag = ["Categories"];
const sec = [{ bearerAuth: [] }];
registry.registerPath({ method: "get", path: "/categories", tags: tag, security: sec, description: "Location categories (Kiosk, Restaurant, ...) with how many locations are in each.", responses: { 200: jsonBody(envelope(z.array(categoryDto))) } });
registry.registerPath({ method: "post", path: "/categories", tags: tag, security: sec, description: "Super Admin only.", request: { body: jsonBody(categoryBody) }, responses: { 201: jsonBody(envelope(categoryDto)), 409: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "patch", path: "/categories/{id}", tags: tag, security: sec, description: "Super Admin only. Renames a category.", request: { params: idParams, body: jsonBody(categoryBody) }, responses: { 200: jsonBody(envelope(categoryDto)), 409: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "delete", path: "/categories/{id}", tags: tag, security: sec, description: "Super Admin only. Refused while locations or content use it.", request: { params: idParams }, responses: { 204: { description: "Deleted" }, 409: jsonBody(ErrorEnvelope) } });

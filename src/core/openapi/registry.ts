import { OpenAPIRegistry, extendZodWithOpenApi, type RouteConfig } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

/** Single registry every module registers its routes into. */
export const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "bearerAuth", { type: "http", scheme: "bearer", bearerFormat: "JWT" });
registry.registerComponent("securitySchemes", "deviceAuth", { type: "http", scheme: "bearer", bearerFormat: "Device credential" });

export const ErrorEnvelope = z
  .object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional(), requestId: z.string().optional() }) })
  .openapi("ErrorEnvelope");

export function envelope<T extends z.ZodTypeAny>(data: T, name?: string) {
  const s = z.object({ data, meta: z.record(z.string(), z.unknown()).optional() });
  return name ? s.openapi(name) : s;
}

export function registerRoute(def: RouteConfig): void {
  registry.registerPath(def);
}

export function jsonBody<T extends z.ZodTypeAny>(schema: T, description = "") {
  return { description, content: { "application/json": { schema } } };
}

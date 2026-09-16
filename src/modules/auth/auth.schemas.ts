import { z } from "zod";
import { registry, envelope, jsonBody, ErrorEnvelope } from "../../core/openapi/registry.js";

export const loginBody = z.object({ email: z.string().email(), password: z.string().min(1) }).openapi("LoginBody");
export const refreshBody = z.object({ refreshToken: z.string().min(1) }).openapi("RefreshBody");
export const forgotBody = z.object({ email: z.string().email() }).openapi("ForgotPasswordBody");
export const resetBody = z.object({ token: z.string().min(1), password: z.string().min(8).max(128) }).openapi("ResetPasswordBody");
export const changePasswordBody = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(128) }).openapi("ChangePasswordBody");

export const userDto = z
  .object({ id: z.string(), email: z.string(), name: z.string(), platformRole: z.string(), companyRole: z.string().nullable(), companyId: z.string().nullable(), title: z.string().nullable(), phone: z.string().nullable() })
  .openapi("AuthUser");
export const tokensDto = z.object({ accessToken: z.string(), refreshToken: z.string(), expiresIn: z.number(), user: userDto }).openapi("AuthTokens");

const tag = ["Auth"];
registry.registerPath({ method: "post", path: "/auth/login", tags: tag, request: { body: jsonBody(loginBody) }, responses: { 200: jsonBody(envelope(tokensDto), "Tokens"), 401: jsonBody(ErrorEnvelope), 429: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "post", path: "/auth/refresh", tags: tag, request: { body: jsonBody(refreshBody) }, responses: { 200: jsonBody(envelope(tokensDto)), 401: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "post", path: "/auth/logout", tags: tag, request: { body: jsonBody(refreshBody) }, responses: { 204: { description: "Logged out" } } });
registry.registerPath({ method: "post", path: "/auth/forgot-password", tags: tag, request: { body: jsonBody(forgotBody) }, responses: { 202: { description: "Accepted" } } });
registry.registerPath({ method: "post", path: "/auth/reset-password", tags: tag, request: { body: jsonBody(resetBody) }, responses: { 204: { description: "Password updated" }, 400: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "get", path: "/auth/me", tags: tag, security: [{ bearerAuth: [] }], responses: { 200: jsonBody(envelope(userDto)), 401: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "post", path: "/auth/change-password", tags: tag, security: [{ bearerAuth: [] }], request: { body: jsonBody(changePasswordBody) }, responses: { 204: { description: "Password updated" }, 400: jsonBody(ErrorEnvelope) } });

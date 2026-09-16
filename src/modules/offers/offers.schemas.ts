import { z } from "zod";
import { paginationQuery } from "../../core/http/pagination.js";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";

export const idParams = z.object({ id: z.string().min(1) });
export const offerStatus = z.enum(["DRAFT", "PUBLISHED", "UNPUBLISHED", "EXPIRED"]);
export const listOffersQuery = paginationQuery.extend({ search: z.string().trim().max(100).optional(), status: offerStatus.optional(), category: z.string().max(60).optional() });
const contact = z.object({ name: z.string().max(120), role: z.string().max(80).optional(), email: z.string().email().optional(), phone: z.string().max(40).optional(), hours: z.string().max(120).optional() });
export const createOfferBody = z.object({
  title: z.string().trim().min(3).max(120), category: z.string().trim().min(2).max(60), summary: z.string().trim().min(10).max(300), description: z.string().trim().min(10).max(5000), instructions: z.string().trim().min(5).max(2000),
  contact, included: z.array(z.string().max(120)).max(20).default([]), steps: z.array(z.string().max(300)).max(20).default([]), imageKey: z.string().max(300).optional(), startsAt: z.string().datetime().nullable().optional(), endsAt: z.string().datetime().nullable().optional(),
}).openapi("CreateOfferBody");
export const updateOfferBody = createOfferBody.partial().openapi("UpdateOfferBody");

export const offerDto = z.object({ id: z.string(), title: z.string(), category: z.string(), status: offerStatus, summary: z.string(), description: z.string(), instructions: z.string(), contact, included: z.array(z.string()), steps: z.array(z.string()), imageUrl: z.string().nullable(), startsAt: z.string().nullable(), endsAt: z.string().nullable(), publishedAt: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(), stats: z.object({ totalViews: z.number(), uniqueViewers: z.number(), lastViewedAt: z.string().nullable() }).optional() }).openapi("Offer");

const tag = ["Offers"];
const sec = [{ bearerAuth: [] }];
registry.registerPath({ method: "get", path: "/offers", tags: tag, security: sec, request: { query: listOffersQuery }, responses: { 200: jsonBody(envelope(z.array(offerDto))) } });
registry.registerPath({ method: "post", path: "/offers", tags: tag, security: sec, request: { body: jsonBody(createOfferBody) }, responses: { 201: jsonBody(envelope(offerDto)), 403: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "get", path: "/offers/{id}", tags: tag, security: sec, request: { params: idParams }, responses: { 200: jsonBody(envelope(offerDto)), 404: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "patch", path: "/offers/{id}", tags: tag, security: sec, request: { params: idParams, body: jsonBody(updateOfferBody) }, responses: { 200: jsonBody(envelope(offerDto)) } });
registry.registerPath({ method: "post", path: "/offers/{id}/publish", tags: tag, security: sec, request: { params: idParams }, responses: { 200: jsonBody(envelope(offerDto)) } });
registry.registerPath({ method: "post", path: "/offers/{id}/unpublish", tags: tag, security: sec, request: { params: idParams }, responses: { 200: jsonBody(envelope(offerDto)) } });
registry.registerPath({ method: "post", path: "/offers/{id}/view", tags: tag, security: sec, request: { params: idParams }, responses: { 202: { description: "View recorded (one per user per 30 minutes)" } } });
registry.registerPath({ method: "get", path: "/offers/{id}/stats", tags: tag, security: sec, request: { params: idParams }, responses: { 200: jsonBody(envelope(z.object({ totalViews: z.number(), uniqueViewers: z.number(), lastViewedAt: z.string().nullable(), byCompany: z.array(z.object({ companyId: z.string().nullable(), views: z.number() })) }))) } });
registry.registerPath({ method: "delete", path: "/offers/{id}", tags: tag, security: sec, request: { params: idParams }, responses: { 204: { description: "Deleted" } } });

import { z } from "zod";
import { paginationQuery } from "../../core/http/pagination.js";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";
import { dateTime, email, endAfterStart, id, list, optionalField, optionalText, phone, text } from "../../core/validation/fields.js";

export const idParams = z.object({ id: id() });
export const offerStatus = z.enum(["DRAFT", "PUBLISHED", "UNPUBLISHED", "EXPIRED"]);
/** The Marketplace categories the dashboards offer. */
export const offerCategory = z.enum(["Hardware", "Software", "Services", "Support", "Retail & Shopping", "Food & Beverage", "Travel & Hospitality", "Technology", "Health & Wellness"]);
export const listOffersQuery = paginationQuery.extend({ search: optionalText(100), status: offerStatus.optional(), category: offerCategory.optional() });
const contact = z.object({ name: z.string().max(120), role: z.string().max(80).optional(), email: z.string().email().optional(), phone: z.string().max(40).optional(), hours: z.string().max(120).optional() });
const contactInput = z.object({ name: text(120), role: optionalText(80), email: optionalField(email()), phone: optionalField(phone()), hours: optionalText(120) }).strict();
/** One bullet or step: at most 50 of them, each up to 200 characters. */
const lines = list(text(200), 50);
/**
 * Fields shared by create and update, deliberately without defaults: `.partial()` keeps a
 * `.default()`, which would reset an omitted list to [] on every PATCH.
 */
const offerFields = {
  title: text(120, 3), category: offerCategory, summary: text(300, 10), description: text(5000, 10), instructions: text(2000, 5),
  contact: contactInput, included: lines, steps: lines, imageKey: optionalText(300), startsAt: dateTime().nullable().optional(), endsAt: dateTime().nullable().optional(),
};
export const createOfferBody = z
  .object({ ...offerFields, included: lines.default([]), steps: lines.default([]) })
  .superRefine(endAfterStart("startsAt", "endsAt"))
  .openapi("CreateOfferBody");
/** Only the fields sent change; the service checks the window against the stored dates. */
export const updateOfferBody = z.object(offerFields).partial().superRefine(endAfterStart("startsAt", "endsAt")).openapi("UpdateOfferBody");

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

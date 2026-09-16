import { z } from "zod";
import { paginationQuery } from "../../core/http/pagination.js";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";

export const idParams = z.object({ id: z.string().min(1) });
export const prizeParams = z.object({ id: z.string().min(1), prizeId: z.string().min(1) });
export const campaignStatus = z.enum(["DRAFT", "SCHEDULED", "ACTIVE", "ENDED", "INACTIVE"]);
export const listCampaignsQuery = paginationQuery.extend({ status: campaignStatus.optional(), search: z.string().trim().max(100).optional() });
export const prizeInput = z.object({ name: z.string().trim().min(1).max(120), value: z.string().max(40).optional(), quantity: z.number().int().min(1).max(100_000), weight: z.number().int().min(1).max(10_000).default(1) });
export const createCampaignBody = z.object({
  title: z.string().trim().min(3).max(120), description: z.string().max(2000).optional(), startsAt: z.string().datetime(), endsAt: z.string().datetime(), maxAttempts: z.number().int().min(1).max(100).default(1), requireOffersVisit: z.boolean().default(false), loseWeight: z.number().int().min(0).max(10_000).default(50), artworkKey: z.string().max(300).optional(), activate: z.boolean().default(false),
  prizes: z.array(prizeInput).min(1).max(50),
}).refine((b) => new Date(b.endsAt) > new Date(b.startsAt), { message: "endsAt must be after startsAt", path: ["endsAt"] }).openapi("CreateCampaignBody");
export const updateCampaignBody = z.object({ title: z.string().trim().min(3).max(120).optional(), description: z.string().max(2000).nullable().optional(), startsAt: z.string().datetime().optional(), endsAt: z.string().datetime().optional(), maxAttempts: z.number().int().min(1).max(100).optional(), requireOffersVisit: z.boolean().optional(), loseWeight: z.number().int().min(0).max(10_000).optional(), artworkKey: z.string().max(300).nullable().optional() }).openapi("UpdateCampaignBody");
export const addPrizeBody = prizeInput.openapi("AddPrizeBody");
export const listWinnersQuery = paginationQuery.extend({ campaignId: z.string().optional(), companyId: z.string().optional(), redemption: z.enum(["PENDING", "REDEEMED"]).optional(), search: z.string().trim().max(100).optional() });

export const prizeDto = z.object({ id: z.string(), name: z.string(), value: z.string().nullable(), quantity: z.number(), remaining: z.number(), awarded: z.number() }).openapi("Prize");
export const campaignDto = z.object({ id: z.string(), title: z.string(), description: z.string().nullable(), status: campaignStatus, startsAt: z.string(), endsAt: z.string(), maxAttempts: z.number(), requireOffersVisit: z.boolean(), artworkUrl: z.string().nullable(), prizes: z.array(prizeDto), attempts: z.number().optional(), winners: z.number().optional(), createdAt: z.string(), updatedAt: z.string() }).openapi("Campaign");
export const attemptResultDto = z.object({ attemptId: z.string(), outcome: z.enum(["WIN", "LOSE"]), prize: z.object({ id: z.string(), name: z.string(), value: z.string().nullable() }).nullable(), attemptsRemaining: z.number() }).openapi("AttemptResult");
export const eligibilityDto = z.object({ eligible: z.boolean(), reason: z.string().nullable(), attemptsUsed: z.number(), attemptsRemaining: z.number() }).openapi("Eligibility");
export const winnerDto = z.object({ id: z.string(), user: z.object({ id: z.string(), name: z.string(), email: z.string() }), company: z.object({ id: z.string(), name: z.string() }).nullable(), campaign: z.object({ id: z.string(), title: z.string() }), prize: z.object({ id: z.string(), name: z.string(), value: z.string().nullable() }), wonAt: z.string(), redemption: z.enum(["PENDING", "REDEEMED"]), redeemedAt: z.string().nullable() }).openapi("Winner");

const tag = ["Campaigns"];
const sec = [{ bearerAuth: [] }];
registry.registerPath({ method: "get", path: "/campaigns", tags: tag, security: sec, request: { query: listCampaignsQuery }, responses: { 200: jsonBody(envelope(z.array(campaignDto))) } });
registry.registerPath({ method: "post", path: "/campaigns", tags: tag, security: sec, request: { body: jsonBody(createCampaignBody) }, responses: { 201: jsonBody(envelope(campaignDto)) } });
registry.registerPath({ method: "get", path: "/campaigns/{id}", tags: tag, security: sec, request: { params: idParams }, responses: { 200: jsonBody(envelope(campaignDto)), 404: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "patch", path: "/campaigns/{id}", tags: tag, security: sec, request: { params: idParams, body: jsonBody(updateCampaignBody) }, responses: { 200: jsonBody(envelope(campaignDto)) } });
registry.registerPath({ method: "post", path: "/campaigns/{id}/activate", tags: tag, security: sec, request: { params: idParams }, responses: { 200: jsonBody(envelope(campaignDto)) } });
registry.registerPath({ method: "post", path: "/campaigns/{id}/deactivate", tags: tag, security: sec, request: { params: idParams }, responses: { 200: jsonBody(envelope(campaignDto)) } });
registry.registerPath({ method: "post", path: "/campaigns/{id}/prizes", tags: tag, security: sec, request: { params: idParams, body: jsonBody(addPrizeBody) }, responses: { 201: jsonBody(envelope(campaignDto)) } });
registry.registerPath({ method: "delete", path: "/campaigns/{id}/prizes/{prizeId}", tags: tag, security: sec, request: { params: prizeParams }, responses: { 200: jsonBody(envelope(campaignDto)) } });
registry.registerPath({ method: "get", path: "/campaigns/{id}/eligibility", tags: tag, security: sec, request: { params: idParams }, responses: { 200: jsonBody(envelope(eligibilityDto)) } });
registry.registerPath({ method: "post", path: "/campaigns/{id}/attempts", tags: tag, security: sec, request: { params: idParams, headers: z.object({ "idempotency-key": z.string() }) }, responses: { 200: jsonBody(envelope(attemptResultDto)), 403: jsonBody(ErrorEnvelope), 409: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "get", path: "/winners", tags: tag, security: sec, request: { query: listWinnersQuery }, responses: { 200: jsonBody(envelope(z.array(winnerDto))) } });
registry.registerPath({ method: "post", path: "/winners/{id}/redeem", tags: tag, security: sec, request: { params: idParams }, responses: { 200: jsonBody(envelope(winnerDto)) } });

import { z } from "zod";
import { paginationQuery } from "../../core/http/pagination.js";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";
import { clearableText, dateTime, endAfterStart, id, int, list, notInPast, optionalText, text } from "../../core/validation/fields.js";

export const idParams = z.object({ id: id() });
export const prizeParams = z.object({ id: id(), prizeId: id() });
export const campaignStatus = z.enum(["DRAFT", "SCHEDULED", "ACTIVE", "ENDED", "INACTIVE"]);
export const listCampaignsQuery = paginationQuery.extend({ status: campaignStatus.optional(), search: optionalText(100) });
export const prizeInput = z.object({ name: text(120), value: optionalText(40), quantity: int(1, 1_000_000), weight: int(1, 1_000_000).default(1) });
export const createCampaignBody = z
  .object({
    title: text(120, 3), description: optionalText(2000), startsAt: dateTime().refine(notInPast, "The start can't be in the past"), endsAt: dateTime(), maxAttempts: int(1, 100).default(1), requireOffersVisit: z.boolean().default(false), loseWeight: int(0, 1_000_000).default(50), artworkKey: optionalText(300), activate: z.boolean().default(false),
    prizes: list(prizeInput, 50, 1),
  })
  .superRefine(endAfterStart("startsAt", "endsAt"))
  .openapi("CreateCampaignBody");
/** Only the fields sent change; the service re-checks the window against the stored dates. */
export const updateCampaignBody = z
  .object({ title: text(120, 3).optional(), description: clearableText(2000), startsAt: dateTime().optional(), endsAt: dateTime().optional(), maxAttempts: int(1, 100).optional(), requireOffersVisit: z.boolean().optional(), loseWeight: int(0, 1_000_000).optional(), artworkKey: clearableText(300) })
  .superRefine(endAfterStart("startsAt", "endsAt"))
  .openapi("UpdateCampaignBody");
export const addPrizeBody = prizeInput.openapi("AddPrizeBody");
export const listWinnersQuery = paginationQuery.extend({ campaignId: id().optional(), companyId: id().optional(), redemption: z.enum(["PENDING", "REDEEMED"]).optional(), search: optionalText(100) });

export const prizeDto = z.object({ id: z.string(), name: z.string(), value: z.string().nullable(), quantity: z.number(), remaining: z.number(), awarded: z.number() }).openapi("Prize");
export const campaignDto = z.object({ id: z.string(), title: z.string(), description: z.string().nullable(), status: campaignStatus, startsAt: z.string(), endsAt: z.string(), maxAttempts: z.number(), requireOffersVisit: z.boolean(), artworkUrl: z.string().nullable(), prizes: z.array(prizeDto), attempts: z.number().optional(), winners: z.number().optional(), createdAt: z.string(), updatedAt: z.string() }).openapi("Campaign");
export const attemptResultDto = z.object({ attemptId: z.string(), outcome: z.enum(["WIN", "LOSE"]), prize: z.object({ id: z.string(), name: z.string(), value: z.string().nullable() }).nullable(), attemptsRemaining: z.number() }).openapi("AttemptResult");
export const myAttemptDto = z.object({ attemptId: z.string(), outcome: z.enum(["WIN", "LOSE"]), prize: z.object({ id: z.string(), name: z.string(), value: z.string().nullable() }).nullable(), redemption: z.enum(["PENDING", "REDEEMED"]).nullable(), createdAt: z.string() }).openapi("MyAttempt");
/** `attempts` is the caller's own history in this campaign, newest first, so the app can show "You won X" again. */
export const eligibilityDto = z.object({ eligible: z.boolean(), reason: z.string().nullable(), attemptsUsed: z.number(), attemptsRemaining: z.number(), attempts: z.array(myAttemptDto) }).openapi("Eligibility");
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

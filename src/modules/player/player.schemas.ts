import { z } from "zod";
import { ErrorEnvelope, envelope, jsonBody, registry } from "../../core/openapi/registry.js";

export const pairingSessionBody = z.object({ deviceId: z.string().trim().min(4).max(120), model: z.string().max(120).optional(), playerVersion: z.string().max(40).optional(), appVersion: z.string().max(40).optional() }).openapi("PairingSessionBody");
export const sessionParams = z.object({ sessionId: z.string().min(1) });
export const heartbeatBody = z.object({ playerVersion: z.string().max(40).optional(), appVersion: z.string().max(40).optional(), firmware: z.string().max(40).optional(), ip: z.string().max(64).optional(), resolution: z.string().max(20).optional(), storageFree: z.number().int().nonnegative().optional(), storageTotal: z.number().int().nonnegative().optional(), currentVersion: z.number().int().nonnegative().optional(), state: z.enum(["PLAYING", "SYNCING", "READY", "OFFLINE", "ERROR"]).optional() }).openapi("HeartbeatBody");
export const syncAckBody = z.object({ version: z.number().int().nonnegative(), status: z.enum(["downloaded", "activated", "failed"]).default("activated"), error: z.string().max(500).optional() }).openapi("SyncAckBody");
export const diagnosticsBody = z.object({ level: z.enum(["info", "warn", "error"]).default("info"), event: z.string().max(80), detail: z.record(z.string(), z.unknown()).optional() }).openapi("DiagnosticsBody");

const manifestItem = z.object({ assetId: z.string(), position: z.number(), durationSec: z.number() }).openapi("ManifestItem");
export const manifestDto = z.object({
  version: z.number(), screenId: z.string(), companyId: z.string(), orientation: z.string(), generatedAt: z.string(), activateAt: z.string().nullable(),
  assignment: z.object({ kind: z.string(), refId: z.string(), name: z.string() }).nullable(),
  /** Playback order for a playlist or template assignment (also a canvas's content). */
  items: z.array(manifestItem),
  layout: z.object({ presetId: z.string(), zones: z.array(z.object({ index: z.number(), name: z.string(), x: z.number(), y: z.number(), w: z.number(), h: z.number(), bindingKind: z.string().nullable(), refId: z.string().nullable(), items: z.array(manifestItem) })) }).nullable(),
  /** Set when the assignment is a canvas: this screen's slot and the slice of the composition it shows (fractions). */
  canvas: z.object({ setId: z.string(), position: z.number(), total: z.number(), activateAt: z.string().nullable(), viewport: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }), content: z.object({ kind: z.string(), refId: z.string() }).nullable() }).nullable(),
  /** Live and upcoming schedules. A SCREEN schedule beats a GROUP schedule, which beats the assignment. */
  schedule: z.array(z.object({ id: z.string(), playlistId: z.string(), name: z.string(), targetKind: z.enum(["SCREEN", "GROUP"]), startsAt: z.string(), endsAt: z.string().nullable(), timezone: z.string(), items: z.array(manifestItem) })),
  /** Every file referenced above, once each, with a signed URL (1 hour). */
  assets: z.array(z.object({ id: z.string(), type: z.string(), mimeType: z.string(), url: z.string(), checksum: z.string().nullable(), sizeBytes: z.number(), width: z.number().nullable(), height: z.number().nullable(), durationSec: z.number().nullable() })),
}).openapi("Manifest");

const tag = ["Player"];
registry.registerPath({ method: "post", path: "/player/pairing-sessions", tags: tag, request: { body: jsonBody(pairingSessionBody) }, responses: { 201: jsonBody(envelope(z.object({ sessionId: z.string(), code: z.string(), expiresAt: z.string() }))), 429: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "get", path: "/player/pairing-sessions/{sessionId}", tags: tag, request: { params: sessionParams }, responses: { 200: jsonBody(envelope(z.object({ status: z.enum(["PENDING", "PAIRED", "EXPIRED"]), screenId: z.string().optional(), credential: z.string().nullable().optional() }))) } });
registry.registerPath({ method: "get", path: "/player/manifest", tags: tag, security: [{ deviceAuth: [] }], responses: { 200: jsonBody(envelope(manifestDto)), 401: jsonBody(ErrorEnvelope) } });
registry.registerPath({ method: "post", path: "/player/heartbeat", tags: tag, security: [{ deviceAuth: [] }], request: { body: jsonBody(heartbeatBody) }, responses: { 200: jsonBody(envelope(z.object({ manifestVersion: z.number(), serverTime: z.string() }))) } });
registry.registerPath({ method: "post", path: "/player/sync-ack", tags: tag, security: [{ deviceAuth: [] }], request: { body: jsonBody(syncAckBody) }, responses: { 204: { description: "Acknowledged" } } });
registry.registerPath({ method: "post", path: "/player/diagnostics", tags: tag, security: [{ deviceAuth: [] }], request: { body: jsonBody(diagnosticsBody) }, responses: { 202: { description: "Recorded" } } });

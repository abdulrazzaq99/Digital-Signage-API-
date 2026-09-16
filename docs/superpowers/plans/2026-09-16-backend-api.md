# Digital Signage Platform API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Node.js Platform API (REST + Socket.IO) with PostgreSQL, Redis, S3 storage, and Docker, covering every domain in spec section 17.1.

**Architecture:** Express 5 app with per-domain MVC modules (routes → controller → service → repository), shared `core/` for errors, middleware, database, Redis, storage, push, realtime, and queues. Prisma schema for spec 18.1. BullMQ worker for async jobs. Everything runs under docker-compose.

**Tech Stack:** Node 22, TypeScript 5, Express 5, Prisma 6, PostgreSQL 16, Redis 7, Socket.IO 4, BullMQ, Zod, zod-to-openapi, Pino, argon2, jsonwebtoken, @aws-sdk/client-s3, Vitest, Supertest, ESLint, Prettier.

**Spec:** `docs/superpowers/specs/2026-09-16-backend-api-design.md`

## Global Constraints

- All endpoints under `/api/v1`; success envelope `{ data, meta? }`; error envelope `{ error: { code, message, details?, requestId } }`.
- Every repository method takes a `TenantScope` first argument. Super Admin scope is `{ kind: "platform", companyId?: string }`; customer scope is `{ kind: "company", companyId: string }`.
- Controllers never touch Prisma. Services never touch `req`/`res`. Repositories never throw `AppError` (they return null/undefined; services decide).
- Every controller is wrapped in `asyncHandler`. Every route has a Zod schema registered in OpenAPI.
- No secrets in code; `src/config/env.ts` validates `process.env` with Zod at boot and exits on error.
- Commit per task, no co-author trailer, nothing pushed without an explicit ask.

## Verification commands (used by every task)

```bash
npm run typecheck && npm run lint
npm test                                  # needs docker compose -f docker/docker-compose.test.yml up -d
docker compose -f docker/docker-compose.yml up --build -d && curl -s localhost:4000/health
```

---

### Task 1: Project scaffold, config, health endpoint, Docker

**Files:**
- Create: `package.json`, `tsconfig.json`, `eslint.config.js`, `.prettierrc`, `.gitignore`, `.env.example`, `README.md`
- Create: `src/config/env.ts`, `src/config/constants.ts`
- Create: `src/app.ts`, `src/server.ts`
- Create: `src/core/http/envelope.ts`, `src/core/middleware/requestId.ts`, `src/core/middleware/logger.ts`
- Create: `src/modules/health/health.routes.ts`, `health.controller.ts`
- Create: `docker/Dockerfile`, `docker/docker-compose.yml`, `docker/docker-compose.test.yml`, `docker/minio-init.sh`

**Produces:**
```ts
// src/config/env.ts
export const env: { NODE_ENV: "development"|"test"|"production"; PORT: number; DATABASE_URL: string; REDIS_URL: string; JWT_ACCESS_SECRET: string; JWT_REFRESH_SECRET: string; JWT_ACCESS_TTL: string; JWT_REFRESH_TTL: string; S3_ENDPOINT: string; S3_REGION: string; S3_BUCKET: string; S3_ACCESS_KEY: string; S3_SECRET_KEY: string; S3_PUBLIC_URL: string; CORS_ORIGINS: string[]; ONESIGNAL_APP_ID?: string; ONESIGNAL_API_KEY?: string; LOG_LEVEL: string }
// src/core/http/envelope.ts
export function ok<T>(res: Response, data: T, meta?: object, status = 200): void
export function created<T>(res: Response, data: T): void
export function noContent(res: Response): void
// src/app.ts
export function createApp(): Express
```

- [ ] Step 1: `npm init -y`; install deps: `express@5 zod pino pino-http argon2 jsonwebtoken @prisma/client ioredis bullmq socket.io @socket.io/redis-adapter @aws-sdk/client-s3 @aws-sdk/s3-request-presigner helmet cors @asteasolutions/zod-to-openapi swagger-ui-express nanoid dayjs`; dev deps: `typescript tsx prisma vitest supertest @types/express @types/node @types/jsonwebtoken @types/supertest @types/cors @types/swagger-ui-express eslint @eslint/js typescript-eslint prettier pino-pretty`.
- [ ] Step 2: Scripts: `dev` (tsx watch src/server.ts), `dev:worker`, `build` (tsc), `start`, `start:worker`, `typecheck`, `lint`, `test` (vitest run), `prisma:migrate`, `prisma:generate`, `seed`, `docs:openapi`.
- [ ] Step 3: `env.ts` parses with Zod; `CORS_ORIGINS` splits on comma; throws a readable list of missing vars.
- [ ] Step 4: `app.ts`: helmet, cors(allowlist), json body 10 MB, requestId (uses incoming `X-Request-Id` or nanoid; sets response header), pino-http with the id, `/health` route, 404 fallthrough, error middleware placeholder (replaced in Task 2). `server.ts` listens on `PORT`, handles SIGTERM with graceful close.
- [ ] Step 5: Health controller returns `{ status: "ok", db: "up"|"down", redis: "up"|"down", version }` (db/redis checks wired in Task 2; stub "unknown" now).
- [ ] Step 6: Dockerfile (multi-stage, `node:22-alpine`, `npm ci`, `prisma generate`, `tsc`, runtime copies `dist`, `node_modules`, `prisma`, `package.json`; `USER node`; `HEALTHCHECK CMD wget -qO- http://localhost:4000/health || exit 1`). Compose with `postgres:16-alpine`, `redis:7-alpine`, `minio/minio` + `minio/mc` init creating bucket `media`, `migrate` (command `npx prisma migrate deploy && npm run seed`), `api`, `worker`. Test compose with postgres and redis on alternate ports 5433/6380.
- [ ] Step 7: Verify `npm run typecheck && npm run lint`, `docker compose -f docker/docker-compose.yml build api`. Commit `Scaffold API project with config, health endpoint, and Docker`.

---

### Task 2: Core: errors, middleware, database, Redis, OpenAPI

**Files:**
- Create: `src/core/errors/AppError.ts`, `src/core/errors/errorHandler.ts`
- Create: `src/core/middleware/asyncHandler.ts`, `validate.ts`, `rateLimit.ts`, `notFound.ts`
- Create: `src/core/db/prisma.ts`, `src/core/db/transaction.ts`
- Create: `src/core/redis/client.ts`
- Create: `src/core/openapi/registry.ts`, `src/core/openapi/document.ts`, `src/core/openapi/routes.ts` (serves `/docs` and `/openapi.json`)
- Create: `src/core/http/pagination.ts`
- Create: `src/core/errors/AppError.test.ts`, `src/core/middleware/validate.test.ts`

**Produces:**
```ts
export class AppError extends Error { constructor(public status: number, public code: string, message: string, public details?: unknown) }
export class ValidationError extends AppError   // 400 VALIDATION_ERROR
export class UnauthorizedError extends AppError // 401 UNAUTHORIZED
export class ForbiddenError extends AppError    // 403 FORBIDDEN
export class NotFoundError extends AppError     // 404 NOT_FOUND
export class ConflictError extends AppError     // 409 CONFLICT
export class RateLimitError extends AppError    // 429 RATE_LIMITED
export const asyncHandler = (fn: (req, res, next) => Promise<unknown>) => (req, res, next) => fn(req, res, next).catch(next)
export function validate(schema: { body?: ZodSchema; query?: ZodSchema; params?: ZodSchema }): RequestHandler   // parsed values on req.validated
export function rateLimit(opts: { key: (req) => string; limit: number; windowSec: number }): RequestHandler  // Redis INCR + EXPIRE
export const prisma: PrismaClient
export function withTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>
export const redis: Redis
export const registry: OpenAPIRegistry; export function registerRoute(def): void
export function parsePagination(query): { page: number; pageSize: number; skip: number; take: number }
```

- [ ] Step 1: Write `AppError.test.ts` asserting each subclass's status and code; write `validate.test.ts` using a throwaway Express app that returns 400 with `details` array `[ { path, message } ]` on bad input.
- [ ] Step 2: Implement. Error handler: if `err instanceof AppError` respond with its status; if `ZodError` map to ValidationError; if Prisma `P2002` map to ConflictError, `P2025` to NotFoundError; else log `err` with stack at error level and respond 500 `INTERNAL_ERROR`. Always include `requestId` from `req.id`. Never include stack in the body.
- [ ] Step 3: Wire `/docs` (swagger-ui) and `/openapi.json`; health now checks `prisma.$queryRaw\`SELECT 1\`` and `redis.ping()`.
- [ ] Step 4: Tests pass; commit `Add core errors, middleware, database, Redis, and OpenAPI`.

---

### Task 3: Prisma schema, migration, seed

**Files:**
- Create: `prisma/schema.prisma`, `prisma/seed.ts`, `prisma/migrations/*` (generated)
- Create: `docs/database.md` (skeleton; completed in Task 12)

Schema (enums and models; every tenant-owned model has `companyId String` with `@@index([companyId])`):

Enums: `PlatformRole { SUPER_ADMIN, CUSTOMER }`, `CompanyRole { ADMIN, EDITOR, VIEWER }`, `CompanyStatus { ACTIVE, INACTIVE, SUSPENDED }`, `LicenseState { ACTIVE, SUSPENDED, DISABLED, EXPIRED }`, `ScreenStatus { ONLINE, OFFLINE, ERROR }`, `PairingStatus { UNPAIRED, PAIRED, REVOKED }`, `Orientation { LANDSCAPE, PORTRAIT }`, `SyncState { SYNCED, PENDING, SYNCING, FAILED }`, `MediaType { IMAGE, VIDEO, PDF }`, `MediaStatus { UPLOADING, PROCESSING, READY, FAILED }`, `PlaylistStatus { DRAFT, PUBLISHED }`, `OfferStatus { DRAFT, PUBLISHED, UNPUBLISHED, EXPIRED }`, `CampaignStatus { DRAFT, SCHEDULED, ACTIVE, ENDED, INACTIVE }`, `RedemptionStatus { PENDING, REDEEMED }`, `AssignmentKind { PLAYLIST, LAYOUT, TEMPLATE_INSTANCE, CANVAS }`, `ActivityStatus { SUCCESS, PENDING, FAILED }`.

Models: `Company`, `User` (email unique, passwordHash, platformRole, companyRole?, companyId?), `RefreshToken` (tokenHash, userId, expiresAt, revokedAt, replacedById), `License` (companyId unique, screenLimit, state, overLimit), `PairingSession` (code unique, deviceId, expiresAt, status, screenId?), `Screen` (companyId, name, location, orientation, status, pairingStatus, lastSeenAt, manifestVersion, ackVersion, syncState, deviceCredentialHash, tags String[]), `ScreenDevice` (screenId unique, model, playerVersion, appVersion, firmware, ip, storageFree), `ScreenGroup`, `ScreenGroupMember` (@@id([groupId, screenId])), `MediaAsset` (companyId, name, type, status, mimeType, sizeBytes, checksum, storageKey, width, height, durationSec, pages, uploadedById), `MediaDerivative` (assetId, kind, storageKey, page?), `Playlist` (companyId, name, status, version), `PlaylistItem` (playlistId, position, assetId, durationSec), `Schedule` (companyId, playlistId, targetKind, targetId, startsAt, endsAt?, timezone), `ScreenAssignment` (screenId unique, kind, refId, version, publishedAt, publishedById), `Layout` (companyId, presetId, name), `LayoutZone` (layoutId, index, name, x,y,w,h as Float 0..1, bindingKind?, bindingId?), `Template` (name, category, orientation, fields Json, isGlobal), `TemplateInstance` (companyId, templateId, values Json, outputKey?), `Offer` (title, category, status, summary, body Json, contact Json, startsAt?, endsAt?, imageKey?), `OfferView` (offerId, userId, companyId, viewedAt; @@index([offerId, userId])), `Notification` (title, body, audience Json, sentAt?, providerId?), `PushSubscription` (userId, companyId?, provider, externalId unique), `ScratchCampaign` (title, description, status, startsAt, endsAt, maxAttempts, requireOffersVisit, allocation Json, artworkKey?), `ScratchPrize` (campaignId, name, value?, quantity, remaining), `ScratchAttempt` (campaignId, userId, companyId, idempotencyKey unique, outcome, prizeId?), `ScratchWinner` (attemptId unique, prizeId, userId, redemption, redeemedAt?), `CanvasSet` (companyId, name, status), `CanvasMember` (setId, screenId unique, position, ready), `ActivityLog` (companyId?, actorId?, action, resourceType, resourceId, status, summary, meta Json), `PlayerHeartbeat` (screenId, at, payload Json), `IdempotencyKey` (key unique, userId, route, responseStatus, responseBody Json, createdAt).

- [ ] Step 1: Write schema; `npx prisma migrate dev --name init`; `npx prisma generate`.
- [ ] Step 2: Seed: Super Admin `admin@dsp.local` / `Admin123!`; companies from the web mock (Acme Retail, City Mall, Fresh Bites, Green Eats Co., Harbor Clinic, Metro Fashion, Skyline Gym, Sunrise Hotels) with licenses; Acme Corp with users Sarah Mitchell `sarah.mitchell@acmecorp.com` / `Customer123!` (ADMIN), James Pearson, Lucy Chen, Marcus Webb, Emma Rodriguez; 8 portal screens, 3 groups, 8 media assets (metadata only, storage keys pointing at seed paths), 3 playlists with items, zone presets as Layout rows with `presetId`, 3 templates, 6 offers, Summer Rewards Draw campaign with 3 prizes, activity entries.
- [ ] Step 3: Commit `Add Prisma schema, initial migration, and demo seed`.

---

### Task 4: Auth module and authorization middleware

**Files:**
- Create: `src/modules/auth/auth.{routes,controller,service,repository,schemas,types,test}.ts`
- Create: `src/core/middleware/authenticate.ts`, `src/core/middleware/authorize.ts`, `src/core/auth/tokens.ts`, `src/core/auth/scope.ts`

**Produces:**
```ts
export type TenantScope = { kind: "platform"; companyId?: string } | { kind: "company"; companyId: string }
export interface AuthUser { id: string; email: string; platformRole: PlatformRole; companyRole: CompanyRole | null; companyId: string | null }
export function authenticate(): RequestHandler            // Bearer JWT → req.user
export function authenticateDevice(): RequestHandler      // Bearer device credential → req.screen
export function authorize(opts: { roles?: CompanyRole[]; platformOnly?: boolean }): RequestHandler // sets req.scope
export function scopeFor(user: AuthUser, requestedCompanyId?: string): TenantScope
export function signAccess(user: AuthUser): string; export function signRefresh(userId: string, jti: string): string
```

- [ ] Step 1: Tests: login success returns access+refresh; wrong password 401; refresh rotates and revokes old (reuse of old → 401 and all family revoked); `GET /auth/me` requires Bearer; expired access token 401 `TOKEN_EXPIRED`; login rate limited after 10/min → 429.
- [ ] Step 2: Implement service with argon2 verify, token issue, refresh rotation (`RefreshToken.replacedById`), logout revokes; forgot/reset password issues a single-use token stored hashed with 1h expiry (email sending is a log line via a `MailProvider` noop).
- [ ] Step 3: `authorize` computes `req.scope`: Super Admin → platform scope with optional `companyId` from `X-Company-Id` header or query; customer → company scope; `roles` checked against `companyRole` for customers.
- [ ] Step 4: Commit `Add auth module with JWT, refresh rotation, and tenant authorization`.

---

### Task 5: Companies, Users, Licenses

**Files:** `src/modules/companies/*`, `src/modules/users/*`, `src/modules/licenses/*` (+ tests each)

- [ ] Step 1: Tests: Super Admin lists all companies; customer Admin gets 403 on `/companies`; customer cannot read another company's users by ID (404, not 403, to avoid enumeration); license `PUT` below paired count sets `overLimit` and writes activity; license `SUSPENDED` blocks publish (tested in Task 8).
- [ ] Step 2: Companies: list (search, status filter, pagination), get, create (also creates License with given limit), update, summary (`screensPaired, online, offline, available`). Users: list/create/update/deactivate scoped; Admin only; cannot demote the last Admin. Licenses: get, update (limit, state) with the over-limit rule.
- [ ] Step 3: Commit `Add companies, users, and licenses modules`.

---

### Task 6: Screens, pairing, groups, player, realtime, presence

**Files:** `src/modules/screens/*`, `src/modules/player/*`, `src/core/realtime/{server,events,emit}.ts`, `src/core/redis/presence.ts`, `src/jobs/presence.sweep.ts`, `src/worker.ts`

**Produces:**
```ts
export const Events = { assignmentUpdated: "screen.assignment.updated", scheduleUpdated: "screen.schedule.updated", remoteRefresh: "screen.remote.refresh", remoteRestart: "screen.remote.restart_player", presence: "screen.presence", syncAck: "screen.sync.ack", mediaReady: "media.ready", offerPublished: "offer.published", canvasActivate: "canvas.activate" } as const
export function emitToScreen(screenId: string, event: string, payload: unknown): void
export function emitToCompany(companyId: string, event: string, payload: unknown): void
export async function touchPresence(screenId: string): Promise<void>; export async function isOnline(screenId: string): Promise<boolean>
```

- [ ] Step 1: Tests: device creates pairing session → code; user pairs with valid code (creates Screen, consumes license slot); invalid code 404 `PAIRING_CODE_INVALID`; expired 410 `PAIRING_CODE_EXPIRED`; already used 409 `DEVICE_ALREADY_PAIRED`; at limit 409 `LICENSE_LIMIT_REACHED`; unpair releases slot; group CRUD and membership; remote command emits to `/player` room and writes activity; heartbeat sets presence and `lastSeenAt`; sync-ack updates `ackVersion` and `syncState`, emits to company room.
- [ ] Step 2: Implement pairing session (6-char code, 5 min TTL, rate limited), pairing transaction with license row lock, device credential (random 48 bytes, hashed at rest, returned once), screens CRUD with filters (status, group, search), groups + members, remote commands.
- [ ] Step 3: Player module: `GET /player/manifest` builds `{ version, screenId, assignment, assets[], schedule[], generatedAt, activateAt? }` from `ScreenAssignment` + playlist/layout; heartbeat; sync-ack; diagnostics stored to `PlayerHeartbeat`.
- [ ] Step 4: Socket.IO server with Redis adapter; `/player` namespace auth via device credential handshake; `/app` namespace auth via JWT, joins `company:<id>`. Presence sweep job every 30 s marks OFFLINE where key missing and emits presence.
- [ ] Step 5: Commit `Add screens, pairing, groups, player endpoints, and real-time presence`.

---

### Task 7: Media

**Files:** `src/modules/media/*`, `src/core/storage/s3.ts`, `src/jobs/media.convert.ts`

- [ ] Step 1: Tests: upload-url returns presigned PUT and asset in UPLOADING; finalize with unsupported MIME → 400 `UNSUPPORTED_MEDIA_TYPE`; finalize over 500 MB → 400; finalize image → READY with derivative thumbnail job enqueued; finalize PDF → PROCESSING and job enqueued; download-url for another company's asset → 404; delete asset used by a playlist → 409 `MEDIA_IN_USE` unless `?force=true` (then playlist items removed and activity written); used-by lists playlists.
- [ ] Step 2: Storage helper: `presignPut(key, contentType)`, `presignGet(key)`, `head(key)`, `delete(key)`. Conversion job: images → thumbnail derivative (sharp optional; if unavailable, record derivative as original); PDF → derivative rows per page as placeholders with `page` index (real rendering is a worker concern; job sets READY and emits `media.ready`).
- [ ] Step 3: Commit `Add media module with presigned uploads, validation, and conversion jobs`.

---

### Task 8: Playlists, schedules, assignments, idempotency

**Files:** `src/modules/playlists/*`, `src/modules/schedules/*`, `src/core/middleware/idempotency.ts`, `src/core/assignments/publish.ts`

- [ ] Step 1: Tests: CRUD; add items with durations; reorder validates a permutation; publish to screens and groups increments `Playlist.version`, upserts `ScreenAssignment` for each target, emits `screen.assignment.updated`, writes activity; publish without `Idempotency-Key` → 400; same key twice → identical response, one assignment; publish with license SUSPENDED → 403 `LICENSE_SUSPENDED`; schedule with end before start → 400; overlapping schedule on same target → 409 `SCHEDULE_CONFLICT` with details; `GET /schedules/active?screenId` resolves precedence (explicit screen schedule over group over default assignment).
- [ ] Step 2: Implement `idempotency()` middleware: requires header on marked routes, looks up `IdempotencyKey` by `(key, userId)`, replays stored response, otherwise captures `res.json` and stores it.
- [ ] Step 3: Commit `Add playlists, schedules, publishing, and idempotency`.

---

### Task 9: Layouts and templates

**Files:** `src/modules/layouts/*`, `src/modules/templates/*`, `src/jobs/template.render.ts`

- [ ] Step 1: Tests: presets list is read-only (5 presets seeded); create layout from preset copies zones; bind zone to media or playlist; publish layout → assignment kind LAYOUT; templates list (global + company); create instance with values validated against `fields` (required, max length) → 400 on violation; render job sets `outputKey`; publish instance → assignment kind TEMPLATE_INSTANCE.
- [ ] Step 2: Commit `Add layouts and templates modules`.

---

### Task 10: Offers and scratch campaigns

**Files:** `src/modules/offers/*`, `src/modules/campaigns/*`

- [ ] Step 1: Tests (offers): Super Admin CRUD; customer sees only PUBLISHED within visibility dates; `POST /offers/:id/view` records one view per user per 30 min; statistics return total, unique, lastViewedAt; publish emits `offer.published`.
- [ ] Step 2: Tests (campaigns): attempt on inactive campaign 409; attempt when `requireOffersVisit` and no view in campaign window 403 `OFFERS_VISIT_REQUIRED`; attempts beyond `maxAttempts` 409 `ATTEMPTS_EXHAUSTED`; same `Idempotency-Key` returns same outcome without new attempt; 50 concurrent attempts against a prize with `remaining = 5` produce exactly 5 winners; winner redemption is idempotent; winners list for Super Admin.
- [ ] Step 3: Allocation: `allocation` JSON `{ prizes: [{ prizeId, weight }], loseWeight }`; weighted pick inside `withTransaction`, `SELECT ... FOR UPDATE` on chosen prize, skip to next candidate if `remaining = 0`.
- [ ] Step 4: Commit `Add offers with view statistics and scratch campaigns with atomic allocation`.

---

### Task 11: Notifications, activity, canvas

**Files:** `src/modules/notifications/*`, `src/modules/activity/*`, `src/modules/canvas/*`, `src/core/push/{PushProvider,onesignal,noop}.ts`, `src/jobs/notification.send.ts`

- [ ] Step 1: Tests: register subscription; create notification for audience `{ companyIds | all }` enqueues send job; Noop provider records calls; activity query filters by type, company, date, paginated; customer sees only own company; canvas set create requires ≥ 2 screens of same orientation → 400 otherwise; readiness reflects presence; activate requires all ready → 409 `CANVAS_DEGRADED`; activation emits `canvas.activate` with `activateAt = now + 5s`.
- [ ] Step 2: Commit `Add notifications, activity, and synchronized canvas modules`.

---

### Task 12: Documentation, Docker end-to-end, final checks

**Files:** `README.md`, `docs/database.md`, `docs/api.md`, `docs/openapi.json` (generated)

- [ ] Step 1: `docs/database.md`: ERD (mermaid), table dictionary from the schema, enum meanings, DBeaver connection (read-only role `reporting` created by a migration), sample queries from spec 18.2, backup/restore with `pg_dump`.
- [ ] Step 2: `docs/api.md`: auth flows, headers, envelopes, error codes, idempotency, rate limits, real-time events, pairing sequence.
- [ ] Step 3: README: prerequisites, `docker compose up`, seeded credentials, running tests, project structure, adding a module.
- [ ] Step 4: `docker compose up --build` from clean; `curl /health`; login as Super Admin; pair a screen through the API; publish; verify `screen.assignment.updated` reaches a socket client (script in `scripts/smoke.ts`).
- [ ] Step 5: Commit `Add database and API documentation and smoke script`.

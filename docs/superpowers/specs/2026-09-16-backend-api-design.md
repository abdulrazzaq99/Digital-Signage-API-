# Digital Signage Platform API — Design

Date: 2026-09-16
Status: Approved in conversation
Sources: `Digital_Signage_Internal_Product_Requirements_and_Implementation_Spec.docx` (sections 2.1, 3, 4, 5, 6, 7, 9, 11, 12, 13, 17, 18, 19, 20), `Mobile_App_Technology_Stack.pdf` (sections 2, 3, 4, 5)

## Goal

The shared Platform API for the web dashboards, the Flutter mobile app, and the Android player. Node.js REST API with a WebSocket channel, PostgreSQL, Redis, S3-compatible media storage, OneSignal push. Runs locally and in production under Docker. Readable MVC structure with typed errors and consistent responses.

## Stack (spec 2.1 and mobile doc 3)

| Concern | Choice |
|---|---|
| Runtime | Node 22 LTS, TypeScript 5 (strict) |
| HTTP | Express 5 |
| Validation | Zod, with OpenAPI 3 generated from the same schemas (`zod-to-openapi`), served at `/docs` |
| Database | PostgreSQL 16 via Prisma 6 (migrations, typed client, DBeaver-browsable) |
| Cache, presence, queues | Redis 7; BullMQ for jobs; Socket.IO Redis adapter |
| Real-time | Socket.IO, namespaces `/player` and `/app` |
| Media storage | S3 API (MinIO in Docker, any S3-compatible bucket in production), presigned PUT and GET |
| Push | OneSignal REST behind a `PushProvider` adapter with a no-op implementation when keys are absent |
| Auth | Argon2 password hashes, JWT access (15 min) and refresh (30 days, rotated, revocable), device credentials for players |
| Logging | Pino, JSON, request ID on every line, `X-Request-Id` echoed |
| Tests | Vitest + Supertest against Postgres and Redis in Docker |
| Container | Multi-stage Dockerfile, non-root, `HEALTHCHECK`; docker-compose for api, worker, postgres, redis, minio, migrate |

## Repository layout

```
Digital-Signage-API/
  src/
    app.ts                 Express app factory (middleware, routes, error handler)
    server.ts              HTTP + Socket.IO bootstrap
    worker.ts              BullMQ worker bootstrap (media conversion, notifications, cleanup)
    config/                env parsing (zod), constants
    core/
      errors/              AppError hierarchy + error middleware
      middleware/          requestId, logger, authenticate, authorize, validate, rateLimit, idempotency, asyncHandler
      db/                  prisma client, transaction helper
      redis/               client, presence, locks
      storage/             S3 client, presigned URL helpers
      push/                PushProvider interface, OneSignal + Noop
      realtime/            Socket.IO server, namespaces, event names, emit helpers
      queue/               BullMQ queues and job names
      http/                response envelope, pagination helpers
      openapi/             registry + document builder
    modules/
      <domain>/
        <domain>.routes.ts       Express router: path, middleware chain, controller
        <domain>.controller.ts   parse request, call service, send envelope
        <domain>.service.ts      business rules, throws AppError
        <domain>.repository.ts   Prisma queries, always tenant-scoped
        <domain>.schemas.ts      Zod request/response schemas (+ OpenAPI registration)
        <domain>.types.ts        DTOs
        <domain>.test.ts         Supertest specs
    jobs/                  BullMQ processors (media.convert, notification.send, presence.sweep)
  prisma/
    schema.prisma
    migrations/
    seed.ts                demo data matching the web dashboards
  docs/
    database.md            ERD, table dictionary, enums, DBeaver connection, sample queries
    api.md                 auth flows, headers, error format, idempotency, real-time events
  docker/
    Dockerfile
    docker-compose.yml
    docker-compose.test.yml
  .env.example
  README.md
```

## Domains (spec 17.1) and their responsibilities

| Module | Endpoints (all under `/api/v1`) |
|---|---|
| auth | `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/forgot-password`, `/auth/reset-password`, `GET /auth/me` |
| companies | Super Admin CRUD, status; `GET /companies/:id/summary` |
| users | list/create/update/deactivate within a company; roles Admin, Editor, Viewer; Super Admin role is platform-level |
| licenses | `GET/PUT /companies/:id/license` (limit, state Active/Suspended/Disabled/Expired); over-limit flag |
| screens | pairing sessions (`POST /player/pairing-sessions` from device, `POST /screens/pair` from user), CRUD, groups and members, assignment, remote commands (`refresh`, `restart_player`), status |
| media | `POST /media/upload-url` (presigned PUT), `POST /media/:id/finalize` (validate type, size, checksum; enqueue conversion), CRUD, `GET /media/:id/download-url` (presigned GET), used-by |
| playlists | CRUD, items, reorder, `POST /playlists/:id/publish` (targets: screens, groups; requires `Idempotency-Key`), versioning |
| schedules | CRUD, timezone-aware start/end, conflict check, active assignment resolution |
| layouts | zone presets (read-only), layout instances with zone bindings, publish |
| templates | template definitions (Super Admin), instances with field values, render job, publish |
| offers | Super Admin CRUD, publish/unpublish, visibility dates, `POST /offers/:id/view` (one per user per session), statistics (total, unique, last viewed) |
| campaigns | scratch campaigns, prizes, `POST /campaigns/:id/attempts` (idempotent, server-decided, atomic inventory), winners, redemption |
| notifications | create and send to audience via PushProvider, subscription registration |
| activity | tenant-scoped audit query; Super Admin cross-tenant query |
| player | `GET /player/manifest`, `POST /player/heartbeat`, `POST /player/sync-ack`, `POST /player/diagnostics` (device credential auth) |
| canvas | synchronized sets, members with position, readiness, activation with shared `activate_at` |

## Cross-cutting rules

- **Envelope.** Success: `{ data, meta? }`. Error: `{ error: { code, message, details?, requestId } }`. Lists paginate with `page`, `pageSize`, `total`.
- **Errors.** `AppError(status, code, message, details)` with subclasses `ValidationError 400`, `UnauthorizedError 401`, `ForbiddenError 403`, `NotFoundError 404`, `ConflictError 409`, `RateLimitError 429`. Anything else becomes 500 `INTERNAL_ERROR` and is logged with the stack. `asyncHandler` wraps every controller.
- **Tenancy.** Every tenant-owned table has `companyId`. `authorize()` resolves the caller's scope: Super Admin may pass `companyId` explicitly; customer users are pinned to their own. Repositories require a `TenantScope` argument, so a query without a tenant does not compile.
- **Licensing.** Pairing is a transaction: lock the license row, count paired screens, reject with `LICENSE_LIMIT_REACHED` when equal. Lowering the limit below the paired count sets `overLimit = true` and writes an activity entry; it never deletes screens.
- **Idempotency.** `Idempotency-Key` header on publish, schedule, and scratch attempts. Stored in `idempotency_keys` with the response; a repeat returns the stored response.
- **Scratch.** Attempt inside a transaction: check campaign active, eligibility (offers-visit rule when enabled), attempts remaining, then `SELECT ... FOR UPDATE` the prize row, decrement, insert attempt and winner. Probability rules live in `scratch_campaigns.allocation` JSON, never sent to clients.
- **Presence.** Heartbeat writes `presence:screen:<id>` in Redis with 90 s TTL; a sweep job marks screens offline when the key expires and emits `screen.presence` to the company room.
- **Manifests.** Versioned per screen; publish increments the version, stores desired state in `screen_assignments`, emits `screen.assignment.updated`. Players fetch the manifest on reconnect.
- **Rate limits.** Login 10/min per IP, pairing validation 20/min per IP, general 300/min per user, stored in Redis.
- **Audit.** Every Super Admin write on customer resources and every publish, pair, unpair, remote command, and license change writes `activity_logs`.
- **Security.** Helmet, CORS allowlist from env, argon2, refresh token rotation with reuse detection, media only via presigned URLs, secrets from env only.

## Real-time (spec 17.2)

Namespace `/player` (device credential): server emits `screen.assignment.updated`, `screen.schedule.updated`, `screen.remote.refresh`, `screen.remote.restart_player`, `canvas.activate`; client emits `screen.presence`, `screen.sync.ack`.
Namespace `/app` (user JWT, room `company:<id>`): server emits `screen.presence`, `screen.sync.ack`, `media.ready`, `offer.published`.

## Data model

Prisma schema implementing spec 18.1: companies, users, refresh_tokens, licenses, screens, screen_devices, screen_groups, screen_group_members, pairing_sessions, media_assets, media_derivatives, playlists, playlist_items, schedules, screen_assignments, layouts, layout_zones, templates, template_instances, offers, offer_views, notifications, push_subscriptions, scratch_campaigns, scratch_prizes, scratch_attempts, scratch_winners, canvas_sets, canvas_members, activity_logs, player_heartbeats, idempotency_keys. Enums for statuses. Indexes on `(companyId)`, `(companyId, status)`, `(companyId, createdAt)`, and lookups used by dashboards.

## Docker

- `docker/Dockerfile`: stage 1 installs deps and builds TypeScript and Prisma client; stage 2 is `node:22-alpine`, copies `dist`, `node_modules` (production), `prisma`; runs as `node`; `HEALTHCHECK` hits `/health`.
- `docker/docker-compose.yml`: `postgres` (16, volume), `redis` (7), `minio` (console on 9001, bucket auto-created), `migrate` (runs `prisma migrate deploy` then seed), `api` (port 4000, depends on migrate), `worker`.
- `docker compose up --build` yields a seeded API. `docker compose -f docker/docker-compose.test.yml run test` runs the suite.

## Verification

- `npm run lint`, `npm run typecheck`, `npm run test` green.
- `docker compose up` then `GET /health` returns `{ status: "ok", db: "up", redis: "up" }` and `POST /api/v1/auth/login` with the seeded Super Admin succeeds.
- Tests cover the backend-testable rows of spec 20: tenant isolation, licensing, pairing, media validation, playlist publish, scheduling conflicts, offer statistics, scratch idempotency and inventory, auth expiry, rate limiting.

## Out of scope

Flutter app, Android player, Tizen, payment/billing, HTML content, freeform designer, production infrastructure provisioning.

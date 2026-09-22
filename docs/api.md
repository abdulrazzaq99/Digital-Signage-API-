# API guide

Base URL: `http://localhost:4000/api/v1` · Interactive docs: `/docs` · Machine-readable spec: `/openapi.json`

## Authentication

| Client | Header | Obtained from |
|---|---|---|
| Web dashboards, mobile app | `Authorization: Bearer <accessToken>` | `POST /auth/login` (15 min), renewed with `POST /auth/refresh` (30 day rotating refresh token) |
| Android player | `Authorization: Bearer <deviceCredential>` | Returned once by `GET /player/pairing-sessions/{sessionId}` after a user pairs the code |

Refresh tokens rotate on every use. Reusing an old refresh token revokes the whole session family. Logging out or changing a password revokes all sessions.

Seeded accounts: Super Admin `admin@dsp.local` / `Admin123!`; customer Admin `sarah.mitchell@acmecorp.com` / `Customer123!`.

## Tenancy

Every customer user is pinned to their company. The Super Admin sees everything and targets one company for write operations with the `X-Company-Id: <companyId>` header (or `?companyId=`). Resources belonging to another company return `404`, never `403`, so IDs cannot be enumerated.

Company roles: `ADMIN` (everything in the company), `EDITOR` (content and screens, no user management), `VIEWER` (read only).

## Envelopes

Success: `{ "data": ..., "meta"?: { page, pageSize, total, totalPages, ... } }`
Error: `{ "error": { "code": "LICENSE_LIMIT_REACHED", "message": "...", "details"?: ..., "requestId": "..." } }`

Every response carries `X-Request-Id`; send your own to correlate logs.

## Common error codes

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Body, query, or params failed validation; `details` lists fields |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Mutation needs an `Idempotency-Key` header |
| `UNAUTHORIZED`, `TOKEN_EXPIRED`, `TOKEN_REUSED`, `DEVICE_UNAUTHORIZED` | 401 | Authentication problems |
| `FORBIDDEN`, `PLATFORM_ONLY`, `INSUFFICIENT_ROLE`, `COMPANY_REQUIRED`, `LICENSE_INACTIVE`, `LICENSE_SUSPENDED`, `OFFERS_VISIT_REQUIRED` | 403 | Authorization or licence rules |
| `NOT_FOUND`, `PAIRING_CODE_INVALID` | 404 | Missing or not visible to the caller |
| `CONFLICT`, `DUPLICATE`, `DEVICE_ALREADY_PAIRED`, `LICENSE_LIMIT_REACHED`, `SCHEDULE_CONFLICT`, `MEDIA_IN_USE`, `PLAYLIST_IN_USE`, `ATTEMPTS_EXHAUSTED`, `CANVAS_DEGRADED` | 409 | State conflicts; `details` explains |
| `PAIRING_CODE_EXPIRED` | 410 | Restart pairing on the device |
| `RATE_LIMITED` | 429 | `Retry-After` header set |
| `INTERNAL_ERROR` | 500 | Logged with the request ID |

## Idempotency

`POST /playlists/{id}/publish`, `POST /layouts/{id}/publish`, `POST /template-instances/{id}/publish`, `POST /canvas/{id}/activate`, `POST /schedules`, and `POST /campaigns/{id}/attempts` require an `Idempotency-Key` header (any unique string up to 128 chars). A retry with the same key returns the original response with `Idempotent-Replayed: true` and performs no second write. Keys are scoped per user.

## Rate limits

Login 10/min per IP · pairing 20/min per IP · pairing session polling 120/min · scratch attempts 30/min per user. Limits are reported in `RateLimit-*` headers.

## Pairing sequence

1. Player: `POST /player/pairing-sessions { deviceId, model, playerVersion }` → `{ sessionId, code }` (code valid 5 minutes).
2. Player shows the code and polls `GET /player/pairing-sessions/{sessionId}` every few seconds.
3. User: `POST /screens/pair { code, name, location, orientation, groupId?, tags? }`. The API locks the licence, rejects at the limit, creates the screen.
4. Player's next poll returns `{ status: "PAIRED", screenId, credential }`. Store it in secure storage and stop polling. If that response was lost, poll again: for 10 minutes after pairing, and until the device first authenticates with a credential, each poll rotates the credential and returns the new one (earlier ones stop working). After that, polls return `credential: null`.
5. Player connects to Socket.IO `/player` with `auth: { token: credential }` and calls `GET /player/manifest`.

## Media upload sequence

1. `POST /media/upload-url { fileName, contentType, sizeBytes }` → `{ asset, uploadUrl }`.
2. `PUT` the bytes to `uploadUrl` with the same `Content-Type` (direct to storage, never through the API).
3. `POST /media/{id}/finalize { width?, height?, durationSec?, pages? }`. The API verifies the object, size, and type; images become `READY`, video and PDF become `PROCESSING` until the worker finishes and emits `media.ready`.

## Real-time events (Socket.IO)

Namespace `/player` (device credential): receives `screen.assignment.updated`, `screen.schedule.updated`, `screen.remote.refresh`, `screen.remote.restart_player`, `canvas.activate`; emits `screen.presence`, `screen.sync.ack { version }`.
Namespace `/app` (user JWT, joins `company:<id>`; Super Admin also joins `platform`): receives `screen.presence`, `screen.sync.ack`, `screen.assignment.updated`, `media.ready`, `offer.published`, `canvas.activate`.

Events are triggers. After reconnecting, players call `GET /player/manifest` and compare `version` with local state.

## Manifest

`GET /player/manifest` returns the desired state: `version`, `assignment` (playlist, layout, template instance, or canvas), `assets[]` with signed URLs (1 hour), sizes and checksums, `layout` zones when applicable, `schedule[]`, and `canvas` position data with `activateAt`. Players download missing assets, then `POST /player/sync-ack { version, status: "activated" }`.

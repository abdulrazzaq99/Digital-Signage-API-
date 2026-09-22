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

## Password reset and invites

- `POST /auth/forgot-password { email }` always answers 202. If the account exists, the worker emails a link `{APP_PUBLIC_URL}/reset-password?token=…`, valid for one hour and usable once.
- `POST /users` without a `password` invites the user: they get an email with the same kind of link, valid for 7 days, to choose their first password. No temporary password is issued.
- Both links are completed with `POST /auth/reset-password { token, password }` (204), which also signs out every existing session. The web app serves `/reset-password`; the mobile apps can claim the same URL as a Universal Link / App Link and read `token` from the query string.

## Push notifications

- Register the device after the OneSignal SDK subscribes: `POST /notifications/subscriptions { externalId, platform }`, where `externalId` is the OneSignal subscription ID (`OneSignal.User.pushSubscription.id`). Call it again whenever the ID changes; `DELETE /notifications/subscriptions/{id}` on sign-out.
- Every push carries `data: { notificationId, type, targetId? }`. `type` is `announcement`, `offer` or `campaign`; `targetId` is the offer or campaign ID and is omitted for announcements.
- Phones also get an OS deep link (OneSignal `app_url`): `dsp://offers/<id>`, `dsp://campaigns/<id>` or `dsp://notifications/<id>`. If the app routes from `data` in its click handler instead, suppress OneSignal's launch-URL handling so the link isn't opened twice. OneSignal `url`/`web_url` is only set for web push, from an `https://` `deepLink`.
- The Super Admin sends with `POST /notifications { title, body, type, targetId, audience, deepLink?, scheduledAt? }`; `targetId` must be an existing offer or campaign (`TARGET_NOT_FOUND`).
- `GET /notifications/inbox` lists sent notifications addressed to the caller (everyone, their company, or them), newest first. `GET /notifications/{id}` returns one, or 404 if the caller isn't in its audience.

## Pairing sequence

1. Player: `POST /player/pairing-sessions { deviceId, model, playerVersion }` → `{ sessionId, code }` (code valid 5 minutes).
2. Player shows the code and polls `GET /player/pairing-sessions/{sessionId}` every few seconds.
3. User: `POST /screens/pair { code, name, location, orientation, groupId?, tags? }`. The API locks the licence, rejects at the limit, creates the screen.
4. Player's next poll returns `{ status: "PAIRED", screenId, credential }`. Store it in secure storage and stop polling. If that response was lost, poll again: for 10 minutes after pairing, and until the device first authenticates with a credential, each poll rotates the credential and returns the new one (earlier ones stop working). After that, polls return `credential: null`.
5. Player connects to Socket.IO `/player` with `auth: { token: credential }` and calls `GET /player/manifest`.

## Media upload sequence

1. `POST /media/upload-url { fileName, contentType, sizeBytes }` → `{ asset, uploadUrl }`.
2. `PUT` the bytes to `uploadUrl` with the same `Content-Type` (direct to storage, never through the API).
   If the connection drops or the URL expires, call `POST /media/{id}/upload-url` for a fresh URL to the same asset (allowed while it is `UPLOADING` or `FAILED`) and PUT again. URL lifetime grows with the declared size, from 15 minutes up to 6 hours. Uploads left `UPLOADING` for 24 hours are deleted.
3. `POST /media/{id}/finalize { width?, height?, durationSec?, pages? }`. The API verifies the object, size, and type; images become `READY`, video and PDF become `PROCESSING` until the worker finishes and emits `media.ready`.

## Real-time events (Socket.IO)

Namespace `/player` (device credential): receives `screen.assignment.updated`, `screen.schedule.updated`, `screen.remote.refresh`, `screen.remote.restart_player`, `canvas.activate`; emits `screen.presence`, `screen.sync.ack { version }`.
Namespace `/app` (user JWT, joins `company:<id>`; Super Admin also joins `platform`): receives `screen.presence`, `screen.sync.ack`, `screen.assignment.updated`, `media.ready`, `offer.published`, `canvas.activate`.

Events are triggers. After reconnecting, players call `GET /player/manifest` and compare `version` with local state.

## Manifest

`GET /player/manifest` returns the desired state, read from one database snapshot:

| Field | Contents |
|---|---|
| `version` | Changes whenever anything below changes. Two fetches with the same version always return the same content. |
| `assignment` | `{ kind, refId, name }` for the published playlist, layout, template instance or canvas, or `null`. |
| `items[]` | Playback order `{ assetId, position, durationSec }` for a playlist or template assignment (and a canvas whose content is one). |
| `layout` | For layouts: `presetId` and `zones[]` with geometry (fractions of the screen) and each zone's `items[]`. |
| `canvas` | For a canvas assignment: `{ setId, position, total, activateAt, viewport, content }`. `viewport` is this screen's slice of the composition as fractions (`x`, `y`, `width`, `height`); members sit left to right in `position` order. |
| `schedule[]` | Live and upcoming schedules (ended less than a day ago or later): `{ id, playlistId, name, targetKind, startsAt, endsAt, timezone, items[] }`. A `SCREEN` schedule beats a `GROUP` schedule, which beats the assignment. |
| `assets[]` | Every file referenced above (assignment and schedules) exactly once: `{ id, type, mimeType, url, checksum, sizeBytes, width, height, durationSec }`. URLs are signed for 1 hour. |
| `activateAt` | Optional shared start time (canvas activation). |

Players download missing assets, `POST /player/sync-ack { version, status: "downloaded" }` once everything is cached, and `{ status: "activated" }` once it is playing. A canvas member counts as ready (preloaded) after acknowledging the current version.

Edits go live on save: changing a playlist (items, order, durations, name), a layout zone, a schedule, a template instance's output, a canvas, a group's members, or deleting media in use bumps `version` on every screen that shows it and sends `screen.assignment.updated`. A template instance keeps its previous output on screen until the new render finishes.

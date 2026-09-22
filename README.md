# Digital Signage Platform API

Shared Platform API for the Super Admin web panel, the customer web dashboard, the Flutter mobile app, and the Android signage player. Node.js, Express 5, TypeScript, PostgreSQL (Prisma), Redis, S3-compatible media storage, Socket.IO real-time channel.

## Quick start (Docker)

```bash
cp .env.example .env
docker compose -f docker/docker-compose.yml up --build
```

This starts PostgreSQL, Redis, MinIO (media storage), runs migrations and the demo seed, then starts the API on http://localhost:4000 and the background worker.

- Health: `GET http://localhost:4000/health`
- OpenAPI docs: http://localhost:4000/docs
- MinIO console: http://localhost:9001 (minio / minio12345). The bucket is private; clients only ever get presigned URLs.
- Mailpit inbox: http://localhost:8025. Password reset and invite emails land here; set `SMTP_URL` to a real relay to deliver them.

### Testing on a phone or a physical player

Signed media URLs point at `S3_PUBLIC_ENDPOINT` (default `http://localhost:9000`), which a phone cannot reach. Start the stack with your machine's LAN IP instead:

```bash
S3_PUBLIC_ENDPOINT=http://192.168.1.20:9000 docker compose -f docker/docker-compose.yml up --build
```

Point the app or player at `http://192.168.1.20:4000` (REST and Socket.IO). Set `APP_PUBLIC_URL` too if emailed reset links should open on the phone. The same variables can live in `docker/.env`, which Compose reads automatically. Add web origins to `CORS_ORIGINS` the same way if a browser on another machine needs access.

## Local development

```bash
npm install
cp .env.example .env
docker compose -f docker/docker-compose.yml up postgres redis minio minio-init mailpit -d
npm run prisma:migrate     # creates the database schema
npm run seed               # loads demo data
npm run dev                # API with reload on http://localhost:4000
npm run dev:worker         # background jobs (also sends mail)
```

With `SMTP_URL` empty, emails are written to the worker log instead of being sent. Set `SMTP_URL=smtp://localhost:1025` to see them in Mailpit.

## Tests

```bash
docker compose -f docker/docker-compose.test.yml up -d   # Postgres :5433, Redis :6380, MinIO :9002
npm test
```

Tests read `.env.test` when present, otherwise the committed `.env.test.example`, whose values match `docker-compose.test.yml` (bucket `media-test`, created automatically).

## Project structure

```
src/
  app.ts            Express app factory
  server.ts         HTTP + Socket.IO bootstrap
  worker.ts         BullMQ worker bootstrap
  config/           environment (validated with Zod) and constants
  core/             errors, middleware, db, redis, storage, push, realtime, queue, openapi
  modules/<domain>/ routes → controller → service → repository (+ schemas, types, tests)
  jobs/             background job processors
prisma/             schema, migrations, seed
docs/               database handover and API guide
docker/             Dockerfile and compose files
```

Each module follows the same shape. Routes declare the middleware chain and map to a controller. Controllers parse validated input and shape the response. Services hold business rules and throw typed `AppError`s. Repositories own Prisma queries and always take a tenant scope.

## Seeded accounts

| Role | Email | Password |
|---|---|---|
| Super Admin | admin@dsp.local | Admin123! |
| Customer Admin (Acme Corp) | sarah.mitchell@acmecorp.com | Customer123! |

## Smoke test against a running stack

```bash
npx tsx scripts/smoke.ts            # defaults to http://localhost:4000
```

Pairs a screen, connects the player socket, publishes a playlist, and asserts the real-time event and manifest.

## Documentation

- `docs/api.md` — auth, tenancy, envelopes, error codes, idempotency, pairing and upload sequences, real-time events
- `docs/database.md` — ERD, table dictionary, enums, DBeaver connection, sample queries, backup and restore
- `docs/openapi.json` — generated with `npm run docs:openapi`

## Adding a module

1. Create `src/modules/<name>/` with `<name>.schemas.ts` (Zod + OpenAPI registration), `<name>.repository.ts` (Prisma only), `<name>.service.ts` (rules, throws `AppError`), `<name>.controller.ts` (parse `req.validated`, send envelope), `<name>.routes.ts` (middleware chain).
2. Mount the router in `src/modules/index.ts`.
3. Add `<name>.test.ts` using the factories in `src/test/factories.ts`.

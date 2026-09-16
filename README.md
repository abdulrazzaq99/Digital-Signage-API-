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
- MinIO console: http://localhost:9001 (minio / minio12345)

## Local development

```bash
npm install
cp .env.example .env
docker compose -f docker/docker-compose.yml up postgres redis minio minio-init -d
npm run prisma:migrate     # creates the database schema
npm run seed               # loads demo data
npm run dev                # API with reload on http://localhost:4000
npm run dev:worker         # background jobs
```

## Tests

```bash
docker compose -f docker/docker-compose.test.yml up -d
npm test
```

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

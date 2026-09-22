# ---- build stage: compile TypeScript and generate the Prisma client ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
# prisma generate only needs the variable to exist; it never connects at build time
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npx prisma generate && npm run build

# ---- one-shot migrate + seed: reuses the build stage so the pinned Prisma CLI is available ----
FROM build AS migrate
CMD ["/bin/sh", "-c", "npx prisma migrate deploy && node dist/prisma/seed.js"]

# ---- production dependencies only ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# ffmpeg/ffprobe (video checks and thumbnails), poppler (PDF pages) and fonts (template text).
RUN apk add --no-cache wget ffmpeg poppler-utils fontconfig font-dejavu
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/prisma ./prisma
COPY --chown=node:node package.json prisma.config.ts ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://localhost:4000/health || exit 1
CMD ["node", "dist/src/server.js"]

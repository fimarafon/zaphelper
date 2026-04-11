# syntax=docker/dockerfile:1.7
# Multi-stage build for the zaphelper backend (Fastify + Prisma).

# -------- deps --------
FROM node:20-alpine AS deps
WORKDIR /app

# Install OpenSSL — Prisma engine needs it on Alpine.
RUN apk add --no-cache openssl

# Workspace files first for layer caching.
COPY package.json package-lock.json* ./
COPY backend/package.json ./backend/
COPY web/package.json ./web/

RUN npm ci --workspace=backend --include-workspace-root

# -------- build --------
FROM node:20-alpine AS build
WORKDIR /app

RUN apk add --no-cache openssl

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/backend/node_modules ./backend/node_modules

COPY package.json package-lock.json* tsconfig.base.json ./
COPY backend ./backend

# Generate Prisma client, then compile TS.
RUN cd backend && npx prisma generate
RUN cd backend && npm run build

# Drop dev dependencies for a smaller runtime image.
RUN cd backend && npm prune --omit=dev

# -------- runtime --------
FROM node:20-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache openssl tini

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/backend/node_modules ./node_modules
COPY --from=build /app/backend/prisma ./prisma
COPY --from=build /app/backend/package.json ./package.json

EXPOSE 3000

# tini handles PID 1 signal forwarding so SIGTERM reaches Node cleanly.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]

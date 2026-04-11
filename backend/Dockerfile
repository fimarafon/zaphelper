# syntax=docker/dockerfile:1.7
# Multi-stage build for the zaphelper backend (Fastify + Prisma).
#
# Build strategy: do the whole install + build + prune in a single "builder"
# stage, then copy only the production artifacts into a slim runtime image.
# This avoids the workspace node_modules hoisting quirks that break
# multi-COPY pipelines.

# ---------- builder ----------
FROM node:20-alpine AS builder
WORKDIR /app

# Prisma and bcryptjs need openssl at build + runtime on Alpine.
RUN apk add --no-cache openssl

# Copy workspace manifests first for better layer caching.
COPY package.json package-lock.json* tsconfig.base.json ./
COPY backend/package.json ./backend/
COPY web/package.json ./web/

# Install all workspaces (we need devDependencies to build TS + Prisma Client).
RUN npm ci --include-workspace-root

# Copy the backend source (web is irrelevant to the backend image).
COPY backend ./backend

# Generate Prisma client + compile TypeScript.
RUN cd backend && npx prisma generate
RUN cd backend && npm run build

# ---------- runtime ----------
FROM node:20-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache openssl tini

ENV NODE_ENV=production
ENV PORT=3000

# We copy the full node_modules from the builder — it was hoisted to the root
# of the workspace, so everything the backend imports resolves from /app/node_modules.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/backend/prisma ./prisma
COPY --from=builder /app/backend/package.json ./package.json

EXPOSE 3000

# tini handles PID 1 signal forwarding so SIGTERM reaches Node cleanly.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]

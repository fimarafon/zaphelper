# syntax=docker/dockerfile:1.7
# Build the Vite SPA and serve it with nginx.
#
# nginx:alpine automatically runs envsubst on files in /etc/nginx/templates/
# at container startup, producing the final config in /etc/nginx/conf.d/.
# We use this to inject BACKEND_HOST and BACKEND_PORT at runtime so the same
# image works in docker-compose (backend:3000) AND EasyPanel
# (studio_zaphelper-backend:3000).

# -------- build --------
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json ./
COPY backend/package.json ./backend/
COPY web/package.json ./web/

# Install all workspaces — simpler and avoids lockfile-with-workspace edge cases.
RUN npm ci --include-workspace-root

COPY web ./web

RUN cd web && npm run build

# -------- runtime --------
FROM nginx:1.27-alpine AS runtime

COPY web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/web/dist /usr/share/nginx/html

# Only substitute vars starting with BACKEND_ so nginx's own $host, $uri etc.
# aren't touched (those use $VAR syntax, but we set the filter just in case).
ENV NGINX_ENVSUBST_FILTER='^BACKEND_'

EXPOSE 80

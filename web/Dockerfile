# syntax=docker/dockerfile:1.7
# Build the Vite SPA and serve it with nginx.
# nginx also reverse-proxies /api and /webhook to the backend container,
# so the browser sees a single origin (cookies Just Work).

# -------- build --------
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY backend/package.json ./backend/
COPY web/package.json ./web/

RUN npm ci --workspace=web --include-workspace-root

COPY tsconfig.base.json ./
COPY web ./web

RUN cd web && npm run build

# -------- runtime --------
FROM nginx:1.27-alpine AS runtime
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

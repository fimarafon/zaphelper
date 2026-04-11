# zaphelper — Deployment

How the current production deployment is configured, how to redeploy, and how to set up a fresh environment from scratch.

## Current production setup

| Component | Value |
|---|---|
| **Domain** | `https://zaphelper.maverstudio.com` |
| **Platform** | EasyPanel on Hostinger VPS |
| **Project** | `studio` |
| **Services** | `zaphelper-postgres`, `zaphelper-backend`, `zaphelper-web` |
| **Git repo** | `github.com/fimarafon/zaphelper` (private) |
| **Auto-deploy** | On push to `main` — EasyPanel rebuilds automatically |
| **VPS IP** | `72.60.2.53` |
| **TLS** | Let's Encrypt via Traefik (automatic) |
| **Backend image** | `easypanel/studio/zaphelper-backend` built from `backend/Dockerfile` |
| **Web image** | `easypanel/studio/zaphelper-web` built from `web/Dockerfile` |
| **Postgres** | `postgres:16-alpine`, persistent volume |

## Deploying a code change

### Normal flow (99% of the time)

```bash
# From the zaphelper project root
git add .
git commit -m "your message"
git push origin main
```

EasyPanel has auto-deploy enabled on both services. Within 30-60 seconds, it detects the push, pulls the new code, rebuilds the Docker image, and replaces the running container. Downtime is typically 5-15 seconds per service.

**What gets rebuilt:**

- If `backend/` changed: backend rebuilds, restarts
- If `web/` changed: web rebuilds, restarts
- If both changed: both rebuild in parallel, web might briefly show backend errors while backend catches up

### Manual rebuild (when EasyPanel webhook doesn't fire)

Rare but happens. Trigger from the EasyPanel UI:

1. Open `https://easypanel.maverstudio.com`
2. Project `studio` → service `zaphelper-backend` (or -web) → **Deploy** button

Or via the EasyPanel API (what I've been using in this session):

```bash
AUTH="Authorization: Bearer <EASYPANEL_API_KEY>"
BASE="https://easypanel.maverstudio.com/api/trpc"

curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"json":{"projectName":"studio","serviceName":"zaphelper-backend","forceRebuild":true}}' \
  "$BASE/services.app.deployService"
```

Same for `zaphelper-web`.

### Rolling back

If a deploy breaks:

```bash
git revert HEAD
git push origin main
```

EasyPanel rebuilds the previous state. Total downtime ~2 minutes.

**Faster:** if EasyPanel keeps old image tags, you can redeploy a previous build from its UI. Check the Deployments tab.

## Environment variables

All secrets live in the EasyPanel backend service environment. To view:

```bash
curl -s -G \
  -H "Authorization: Bearer <EASYPANEL_API_KEY>" \
  --data-urlencode 'input={"json":{"projectName":"studio","serviceName":"zaphelper-backend"}}' \
  "https://easypanel.maverstudio.com/api/trpc/services.app.inspectService" \
  | jq -r '.result.data.json.env'
```

To update:

```bash
# Use Python not bash — bash mangles $ in bcrypt hashes
python3 <<PYEOF
import json, urllib.request
AUTH = "Bearer <EASYPANEL_API_KEY>"
BASE = "https://easypanel.maverstudio.com/api/trpc"

# Read current env, parse, modify, write back
# (see AUDIT-FIXES.md for a real example)
PYEOF
```

### Full env var list

See [`.env.example`](../.env.example) for the canonical template with comments. Required:

- `NODE_ENV=production`
- `DATABASE_URL=postgres://postgres:<pass>@studio_zaphelper-postgres:5432/studio`
- `EVOLUTION_API_URL=https://evolution.maverstudio.com`
- `EVOLUTION_API_KEY=<the admin key>`
- `EVOLUTION_INSTANCE_NAME=zaphelper-main`
- `WEBHOOK_URL=https://zaphelper.maverstudio.com/webhook`
- `ADMIN_USER=filipeadmin`
- `ADMIN_PASSWORD_HASH=<bcrypt hash, 60 chars>`
- `JWT_SECRET=<32+ random chars>`
- `COOKIE_SECURE=true`
- `BE_HOME_LEADS_GROUP_NAME=Be Home Leads Scheduled`
- `TZ=America/Los_Angeles`

Optional:
- `SELF_PHONE_NUMBER=16198886149` (usually auto-detected)
- `ELEVENLABS_API_KEY=<key>` (only needed for `sendVoice` action)

### Generating secrets

```bash
# JWT_SECRET
openssl rand -hex 32

# Postgres password
openssl rand -hex 24

# Bcrypt hash (don't forget quotes so bash doesn't interpret $)
node -e "const b=require('bcryptjs'); console.log(b.hashSync('your-password-here', 10))"
```

**Always** verify the bcrypt hash is exactly 60 characters. If it's shorter, bash mangled the `$` prefix and you'll lock yourself out.

## EasyPanel service config

### zaphelper-postgres

```yaml
image: postgres:16-alpine
env:
  POSTGRES_USER: postgres
  POSTGRES_PASSWORD: <strong-random>
  POSTGRES_DB: studio
volumes:
  - postgres-data:/var/lib/postgresql/data
```

Accessible internally as `studio_zaphelper-postgres:5432`.

### zaphelper-backend

```yaml
build:
  type: dockerfile
  file: backend/Dockerfile
source:
  type: github
  owner: fimarafon
  repo: zaphelper
  ref: main
  path: /
  autoDeploy: true
env:
  NODE_ENV: production
  PORT: 3000
  HOST: 0.0.0.0
  # ... (see env var list above)
expose:
  - "3000"
# No public port — only reachable via internal network from zaphelper-web.
```

### zaphelper-web

```yaml
build:
  type: dockerfile
  file: web/Dockerfile
source:
  type: github
  owner: fimarafon
  repo: zaphelper
  ref: main
  path: /
  autoDeploy: true
env:
  BACKEND_HOST: studio_zaphelper-backend
  BACKEND_PORT: "3000"
domains:
  - host: zaphelper.maverstudio.com
    https: true
    path: /
    port: 80
    certificateResolver: ""  # empty = Traefik default (Let's Encrypt)
```

## Dockerfile details

### Backend (`backend/Dockerfile`)

```dockerfile
# Single-stage Node.js with Prisma and Fastify
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json package-lock.json* tsconfig.base.json ./
COPY backend/package.json ./backend/
COPY web/package.json ./web/
RUN npm ci --include-workspace-root
COPY backend ./backend
RUN cd backend && npx prisma generate
RUN cd backend && npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache openssl tini
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/backend/prisma ./prisma
COPY --from=builder /app/backend/package.json ./package.json
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
```

Key points:
- Uses `npm ci --include-workspace-root` to install both workspaces' deps. We need web's package-lock.json to resolve but don't build web here.
- `prisma migrate deploy` runs on startup — applies any new migrations, then exits, then node starts.
- `tini` is PID 1 so SIGTERM from EasyPanel triggers the graceful shutdown handler.
- No multi-stage prune; the image is ~300 MB. Acceptable.

### Web (`web/Dockerfile`)

```dockerfile
# Build Vite SPA, serve with nginx
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY backend/package.json ./backend/
COPY web/package.json ./web/
RUN npm ci --include-workspace-root
COPY web ./web
RUN cd web && npm run build

FROM nginx:alpine AS runtime
COPY web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=builder /app/web/dist /usr/share/nginx/html
# nginx.conf.template uses envsubst at container start to inject BACKEND_HOST + BACKEND_PORT
```

The `nginx.conf.template` uses envsubst variables `${BACKEND_HOST}` and `${BACKEND_PORT}` which are replaced at container start by the nginx:alpine image's built-in template handling. This lets us use the same config for both docker-compose (`backend:3000`) and EasyPanel (`studio_zaphelper-backend:3000`).

## First-time deploy checklist

If you're setting up a fresh environment (new VPS or recreating from scratch):

### Prerequisites

- [ ] Hostinger VPS (or similar) running Ubuntu 22.04+
- [ ] EasyPanel installed (see <https://easypanel.io/docs>)
- [ ] Domain with DNS controllable (Cloudflare, Hostinger DNS, whatever)
- [ ] Evolution API already running somewhere reachable (same VPS is fine)
- [ ] A GitHub account with a repo for zaphelper

### Step-by-step

#### 1. DNS

Point `zaphelper.yourdomain.com` → VPS IP via an `A` record. Wait for propagation (a few minutes).

#### 2. Push code to GitHub

```bash
cd /path/to/zaphelper
git init
git add .
git commit -m "Initial commit"
gh repo create yourgithub/zaphelper --private --source=. --push
```

Or if you prefer, push to an existing repo:
```bash
git remote add origin git@github.com:yourgithub/zaphelper.git
git push -u origin main
```

#### 3. Create services in EasyPanel

Three services, in order:

**a) Postgres**

```
Service type: Postgres
Name: zaphelper-postgres
Version: 16
Password: <generate with openssl rand -hex 24>
```

**b) Backend**

```
Service type: App
Name: zaphelper-backend
Source: GitHub → owner=yours, repo=zaphelper, ref=main
Build: Dockerfile → backend/Dockerfile
Environment: (fill in all vars from .env.example)
Expose: 3000 (no public port)
Deploy: autoDeploy=true
```

Don't deploy yet — the env vars aren't set.

**c) Web**

```
Service type: App
Name: zaphelper-web
Source: GitHub → same repo
Build: Dockerfile → web/Dockerfile
Environment:
  BACKEND_HOST=<project-prefix>_zaphelper-backend
  BACKEND_PORT=3000
Ports: 80 (public)
Domains: add zaphelper.yourdomain.com, HTTPS on, certResolver empty
Deploy: autoDeploy=true
```

#### 4. Set backend env vars

Before the first deploy, make sure `ADMIN_PASSWORD_HASH` is set to a **real 60-character bcrypt hash** (not bash-mangled). The safest way is to generate it with Python via the EasyPanel API:

```python
import json, urllib.request

NEW_HASH = "$2a$10$..."  # from node -e "..."

body = {"json": {"projectName": "studio", "serviceName": "zaphelper-backend", "env": "..."}}
# ... POST to /api/trpc/services.app.updateEnv
```

**Verify** the hash is 60 chars after setting:

```bash
curl -s -G -H "Authorization: Bearer $EP_KEY" \
  --data-urlencode 'input={"json":{"projectName":"studio","serviceName":"zaphelper-backend"}}' \
  "https://easypanel.maverstudio.com/api/trpc/services.app.inspectService" \
  | jq -r '.result.data.json.env' | grep ADMIN_PASSWORD
```

#### 5. Deploy backend

Click Deploy in EasyPanel. Watch the logs for:
- `Scheduler started`
- `ScheduledTaskRunner started`
- `IncrementalSync started`
- `zaphelper listening`
- (Expected warnings about Evolution if it's not connected yet)

#### 6. Deploy web

Click Deploy. Wait for Vite build + nginx start (~30s).

#### 7. Verify reachability

```bash
curl -sk https://zaphelper.yourdomain.com/health
```

Should return `{"ok":true,"checks":{"db":{"ok":true,"latencyMs":N},"evolution":{"ok":true},"selfIdentity":{"ok":false}}}`.

`selfIdentity.ok` will be false until the WhatsApp QR is scanned.

#### 8. Connect WhatsApp

1. Open the dashboard in browser
2. Log in with `filipeadmin` / your password
3. Dashboard → Connect WhatsApp → scan QR with phone
4. Wait ~5 seconds for the state to flip to `CONNECTED`
5. Once connected, the self-identity auto-detects and `/health` shows `selfIdentity.ok: true`

#### 9. Backfill historical messages

Run a full backfill to pull everything Evolution has:

```bash
curl -X POST -b cookies.txt -H "Content-Type: application/json" \
  -d '{}' https://zaphelper.yourdomain.com/api/instance/backfill
```

Takes ~1 minute for 10k messages.

#### 10. Import names from a legacy instance (if applicable)

Only needed if you have an older Evolution instance with the correct pushNames:

```bash
curl -X POST -b cookies.txt -H "Content-Type: application/json" \
  -d '{"sourceInstance": "old-instance-name"}' \
  https://zaphelper.yourdomain.com/api/instance/import-names
```

#### 11. Smoke test

```bash
# From the dashboard or via curl:
curl -X POST -b cookies.txt -H "Content-Type: application/json" \
  -d '{"input":"/statustoday"}' \
  https://zaphelper.yourdomain.com/api/commands/run
```

Should return a valid status reply.

#### 12. Send a command via WhatsApp self-chat

Open WhatsApp on your phone, send `/help` to yourself. Reply should arrive in 1-2 seconds.

**Done. You're live.**

## Backup considerations

The current deployment has **no automated backups of Postgres**. See [AUDIT.md § Data reliability](./AUDIT.md#data-reliability) for the recommended mitigation.

Manual backup:

```bash
# SSH into the VPS
docker exec studio_zaphelper-postgres pg_dump -U postgres studio > zaphelper-$(date +%F).sql
# Copy off-box
scp root@72.60.2.53:zaphelper-*.sql ./backups/
```

Restore:

```bash
# On the VPS
docker exec -i studio_zaphelper-postgres psql -U postgres studio < zaphelper-2026-04-11.sql
```

**Test restore at least once a quarter.** An untested backup is an unfortunate hope.

## Zero-downtime considerations

Currently we have **some downtime** on every deploy (~10-30s). Mitigations:

- [x] Graceful shutdown drains in-flight requests before killing the container
- [x] IncrementalSync recovers any messages dropped during the restart window
- [x] Reminders past-due on boot are fired with `[missed]` prefix
- [x] Scheduled tasks past-due on boot are fired with `[missed run]` prefix
- [ ] Blue-green deploys (future): run 2 replicas behind Traefik, deploy one at a time

At current scale (1 user), the downtime is invisible in practice.

## Monitoring

Currently minimal:

- **EasyPanel service stats** (CPU, RAM, network) — visible in the dashboard
- **`/health` endpoint** — returns 503 if DB or Evolution unreachable; EasyPanel healthchecks pick this up
- **Backend stdout logs** — visible in EasyPanel's log viewer, ephemeral

**Not yet:**

- External uptime monitoring (UptimeRobot)
- Log shipping (Axiom, Logtail, Grafana Cloud)
- Metrics (Prometheus)
- Alerting on failures

See AUDIT.md for the roadmap.

## Troubleshooting a failed deploy

### Symptom: container crash-loops on startup

Check logs in EasyPanel. Most common causes:

1. **Prisma migration failure** — a new migration has a syntax error or references a column that doesn't exist. Check `dist/` was rebuilt properly.
2. **Missing env var** — the zod config schema rejects on startup. Log shows which var is missing.
3. **Evolution unreachable at boot** — this shouldn't crash us (wrapped in try/catch) but triple-check.
4. **Port conflict** — shouldn't happen on EasyPanel but worth checking.

### Symptom: container runs but `/health` returns 503

Check the `checks` object in the response:

- `checks.db.ok: false` → Postgres is down or the DATABASE_URL is wrong
- `checks.evolution.ok: false` → Evolution is down or EVOLUTION_API_KEY is wrong
- `checks.selfIdentity.ok: false` → WhatsApp not connected yet, scan the QR

### Symptom: everything green but WhatsApp messages aren't arriving

Check:

1. `curl /webhook/find/zaphelper-main` on Evolution — does it point at your domain?
2. Is the Evolution instance in `connectionStatus: "open"`?
3. Has the QR been scanned recently?
4. Is the incremental sync running? Check `monitor.getServiceStats` for CPU activity every 5 min.

See [RUNBOOK.md](./RUNBOOK.md) for detailed incident response.

# zaphelper — Development

Local dev setup, how to run the stack on your machine, how to run tests, and the day-to-day workflow for making changes.

## Prerequisites

- **Node.js 20+** (use `nvm` if you need multiple versions)
- **npm** (comes with Node)
- **PostgreSQL 15+** — locally installed or via Docker
- **Git**
- **A code editor** with TypeScript support (VS Code recommended)
- **The `gh` CLI** (optional, for GitHub operations)

**You do NOT need Docker** for local development — we run the backend and frontend directly with `tsx` and `vite`. Only Postgres needs to be running.

## First-time setup

### 1. Clone and install

```bash
git clone https://github.com/fimarafon/zaphelper.git
cd zaphelper
npm install
```

This installs dependencies for both workspaces (`backend` and `web`) in one shot thanks to npm workspaces.

### 2. Start Postgres

**Option A — Homebrew (macOS):**

```bash
brew install postgresql@16
brew services start postgresql@16
createdb zaphelper
```

Default connection string: `postgresql://$(whoami)@localhost:5432/zaphelper`

**Option B — Docker:**

```bash
docker run -d --name zaphelper-pg \
  -e POSTGRES_USER=zaphelper \
  -e POSTGRES_PASSWORD=dev \
  -e POSTGRES_DB=zaphelper \
  -p 5432:5432 \
  postgres:16-alpine
```

Connection string: `postgresql://zaphelper:dev@localhost:5432/zaphelper`

### 3. Create `.env`

```bash
cp .env.example .env
```

Edit the values. Minimum needed for dev:

```env
NODE_ENV=development
PORT=3000
HOST=0.0.0.0
DATABASE_URL=postgresql://macbook@localhost:5432/zaphelper

# Use real Evolution (from maverstudio) OR stub with placeholder URLs
EVOLUTION_API_URL=https://evolution.maverstudio.com
EVOLUTION_API_KEY=yFKYj2Tod04LvCRjxUHOcyIao3p6QOoE
EVOLUTION_INSTANCE_NAME=zaphelper-dev   # different from prod!

WEBHOOK_URL=http://localhost:3000/webhook

ADMIN_USER=admin
# Generate with: node -e "console.log(require('bcryptjs').hashSync('admin123', 10))"
ADMIN_PASSWORD_HASH=$2a$10$02vSQCchsgN.koM9EBrpWOLNlLhVLkZvZgZ3FACkIMbc9TCcbRRDq
JWT_SECRET=dev-local-jwt-secret-at-least-16-chars
COOKIE_SECURE=false

BE_HOME_LEADS_GROUP_NAME=Be Home Leads Scheduled
TZ=America/Los_Angeles
```

**Important:**

- Use a **different** `EVOLUTION_INSTANCE_NAME` than prod (`zaphelper-dev`, not `zaphelper-main`). Otherwise your local dev will fight prod for the WhatsApp connection.
- `COOKIE_SECURE=false` so browsers accept cookies over http://localhost
- Don't commit `.env` — it's gitignored

### 4. Run migrations

```bash
cd backend
DATABASE_URL="postgresql://macbook@localhost:5432/zaphelper" npx prisma migrate deploy
npx prisma generate
```

(You can omit `DATABASE_URL=...` if the shell env already has it from your `.env`, but Prisma doesn't auto-read `.env` — you need `dotenv-cli` or explicit var.)

### 5. Run the stack

Two terminals:

**Terminal 1 — backend:**

```bash
cd backend
npm run dev
```

This runs `tsx watch src/server.ts` which hot-reloads on file changes. You should see:

```
[HH:MM:SS] INFO: Starting zaphelper
[HH:MM:SS] INFO: Scheduler started
[HH:MM:SS] INFO: ScheduledTaskRunner started
[HH:MM:SS] INFO: IncrementalSync started
[HH:MM:SS] INFO: zaphelper listening
```

Backend is at http://localhost:3000.

**Terminal 2 — web:**

```bash
cd web
npm run dev
```

Vite starts on http://localhost:5173 with HMR. The dev server proxies `/api` and `/webhook` to `http://localhost:3000` (configured in `web/vite.config.ts`).

### 6. Open the dashboard

Navigate to http://localhost:5173 in your browser.

Login: `admin` / `admin123` (or whatever you put in `.env`).

### 7. Connect WhatsApp (optional)

If you want to test the full flow end-to-end:

1. Dashboard → Connect WhatsApp
2. Scan the QR with a WhatsApp account (ideally a throwaway one, not your main)
3. The `zaphelper-dev` instance on `evolution.maverstudio.com` gets paired
4. Webhook URL is `http://localhost:3000/webhook`, which is **not reachable from Evolution** unless you use a tunnel

**Options for webhook in dev:**

- **ngrok**: `ngrok http 3000` → update `WEBHOOK_URL` in `.env` to the ngrok URL → restart backend
- **Cloudflared tunnel**: similar
- **Test without webhook**: use the dashboard's "🧪 Test command" input on the Commands page; it bypasses the webhook

### 8. Alternative: connect to prod Evolution but dev DB

You can point your local backend at the **production** Evolution API (`zaphelper-main` instance) but your **local** Postgres. This gives you real WhatsApp messages landing in your local DB. Use for debugging real bugs.

```env
EVOLUTION_INSTANCE_NAME=zaphelper-main  # production!
DATABASE_URL=postgresql://macbook@localhost:5432/zaphelper  # local
WEBHOOK_URL=https://ngrok-url/webhook  # ngrok or similar
```

**Warning:** this means the prod Evolution instance now has 2 webhooks (prod + your dev). Messages arrive at both. Only do this briefly while debugging.

**Better option:** run a backfill from prod Evolution into your local DB:

```bash
# Log in to your local backend
curl -X POST -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' \
  -c /tmp/local-cookies.txt http://localhost:3000/api/auth/login

# Trigger backfill (pulls from prod Evolution into local DB)
curl -X POST -b /tmp/local-cookies.txt -H "Content-Type: application/json" \
  -d '{}' http://localhost:3000/api/instance/backfill
```

Now your local DB has real data you can play with.

## Daily workflow

### Making a backend change

1. Edit the file (`backend/src/...`)
2. `tsx watch` auto-reloads the backend
3. Hit the affected endpoint via curl or the dashboard
4. Check logs in terminal 1

### Making a frontend change

1. Edit the file (`web/src/...`)
2. Vite hot-reloads the browser
3. Check the browser devtools console for errors

### Running tests

```bash
cd backend
npm test
```

Current coverage: **only** `lead-parser.test.ts` (10 tests). See [AUDIT.md § Maintainability](./AUDIT.md#maintainability) for what's missing.

To run a single test file in watch mode:

```bash
cd backend
npx vitest watch src/services/lead-parser.test.ts
```

### Typechecking

```bash
cd backend
npx tsc --noEmit    # backend only
```

```bash
cd web
npx tsc -b --noEmit  # frontend only
```

Both happen automatically on `npm run build`.

### Building for production

```bash
# Backend
cd backend
npm run build   # writes to backend/dist/

# Web
cd web
npm run build   # writes to web/dist/
```

Usually you don't do this locally — EasyPanel builds on deploy.

## Database operations

### Inspect data

```bash
cd backend
DATABASE_URL="postgresql://macbook@localhost:5432/zaphelper" npx prisma studio
```

Opens a GUI at http://localhost:5555 where you can browse all tables.

### Write a new migration

1. Edit `prisma/schema.prisma`
2. `DATABASE_URL=... npx prisma migrate dev --name your_change_name`
3. This creates a timestamped migration in `prisma/migrations/` and applies it to your local DB
4. Commit the migration folder — it'll run on prod via `prisma migrate deploy` on next deploy

**Important:** don't manually edit past migrations. Always create a new one, even for small changes.

### Reset local DB

```bash
cd backend
DATABASE_URL="..." npx prisma migrate reset
```

Drops all tables, re-runs all migrations, leaves you with an empty DB.

### Seed local DB

Not set up as a formal Prisma seed, but you can run the backfill to pull real data from Evolution into your local DB (see above).

## Adding a new feature

### Feature: a new command

See [COMMANDS.md § Adding a new command](./COMMANDS.md#adding-a-new-command).

TL;DR:
1. Create `backend/src/commands/<name>.command.ts`
2. Export a `Command` object
3. Add it to `staticCommands[]` in `registry.ts`
4. Write a test (ideally)
5. `git push` → prod

### Feature: a new action type for scheduled tasks

See [ACTIONS.md § Adding a new action type](./ACTIONS.md#adding-a-new-action-type).

### Feature: a new API endpoint

1. Create or edit a file in `backend/src/routes/`
2. Export a `FastifyPluginAsync` following the pattern of existing routes
3. Register in `server.ts`: `await app.register(yourRoute, { ... })`
4. Pass any dependencies it needs via the options object
5. Use `requireAuth(req)` at the top of any route that needs login

### Feature: a new dashboard page

1. Create `web/src/pages/YourPage.tsx`
2. Add a route in `web/src/App.tsx`
3. Add a nav link in `web/src/components/Layout.tsx`
4. Use TanStack Query hooks for data fetching (see existing hooks in `web/src/api/hooks.ts` as examples)
5. Follow the existing class patterns (`card`, `btn-primary`, `table`, etc. defined in `web/src/index.css`)

### Feature: a new Prisma model

1. Edit `backend/prisma/schema.prisma`
2. `npx prisma migrate dev --name add_foo_model`
3. Regenerate client: `npx prisma generate`
4. Use the new model in services/routes
5. Commit schema + migration

## Code style

- **TypeScript everywhere.** No raw JS.
- **Strict mode on.** No `any` unless there's a very good reason; use `unknown` and narrow.
- **Functional over OO** where possible, but classes are fine for stateful services (Scheduler, Dispatcher, etc.)
- **No prettier config yet** — match the existing code style (2-space indent, double quotes in TS).
- **Imports sorted** by path depth (external → internal).
- **Comments** explain **why**, not **what**. The code says what.
- **Error handling**: prefer returning `{ success, error }` over throwing, except where thrown errors are caught by the framework (e.g. Fastify error handler).

## Debug techniques

### Backend logs

pino is the logger. Change `createLogger(nodeEnv)` to `'debug'` temporarily to see everything:

```typescript
// backend/src/logger.ts — just change the line:
level: isDev ? "debug" : "info",
// to:
level: "debug",
```

### SQL queries

Prisma logs queries in dev mode via the log config in `backend/src/prisma.ts`. You see every SELECT/INSERT/UPDATE in the terminal. If it's too noisy, set `log: ["error"]`.

### A specific Evolution API call

Add a `console.log` in `backend/src/evolution/client.ts` in the `request()` method. Or grep the logs for the `evolution-client` component.

### Reproduce a production bug locally

1. Pull the offending message from prod Evolution: `curl '.../chat/findMessages/zaphelper-main' ...`
2. Save it as a fixture in `backend/src/__fixtures__/message-<id>.json`
3. Write a test that feeds it to `parseLeadWithReason` / `ingest.ingestRaw` / whatever
4. Run the test — if it passes, the bug isn't in parsing; if it fails, you found it

### Fastify inspector

Fastify has a built-in list-routes feature:

```typescript
// Temporary in server.ts:
console.log(app.printRoutes());
```

Shows all registered routes and their middleware chain.

## Common gotchas

### `$` in bcrypt hashes eaten by bash

```bash
# WRONG — bash substitutes $2a as "" and $10 as ""
HASH="$(node -e '...')"
export ADMIN_PASSWORD_HASH=$HASH
curl -d "{\"env\": \"ADMIN_PASSWORD_HASH=$HASH\"}" ...
```

```bash
# RIGHT — pipe through Python or write to a file
node -e '...' > /tmp/hash.txt
HASH_FILE=/tmp/hash.txt python3 set-env.py
```

Or use single quotes everywhere so bash leaves `$` alone.

### Timezone confusion

`date-fns` operates on `Date` objects which are always UTC internally. All conversion to/from a timezone happens via `date-fns-tz` helpers in `backend/src/utils/dates.ts`. Use those, not raw `.setHours(0)`.

### Prisma nullable fields

A field marked `String?` in Prisma is `string | null` in TypeScript, not `undefined`. When filtering with `where`, use `{ field: null }` not `{ field: undefined }`.

### React Query cache

After a mutation (create/delete), you need to invalidate the query cache:

```typescript
const qc = useQueryClient();
const mutation = useMutation({
  mutationFn: ...,
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: ["schedules"] });
  },
});
```

Without this, the UI shows stale data until the next refetch interval.

### Webhook body-parser edge case

Fastify has a custom `application/json` parser in `server.ts` that accepts empty bodies (because some browsers POST with no body). If you write a new webhook source, make sure it doesn't confuse this — use a distinct Content-Type if you need different handling.

## Deployment from local

You normally don't — `git push` to main triggers auto-deploy. But if you need to force a rebuild without a commit:

```bash
# Via EasyPanel API
curl -s -X POST \
  -H "Authorization: Bearer $EP_KEY" \
  -H "Content-Type: application/json" \
  -d '{"json":{"projectName":"studio","serviceName":"zaphelper-backend","forceRebuild":true}}' \
  https://easypanel.maverstudio.com/api/trpc/services.app.deployService
```

## What NOT to do locally

- **Don't run migrations against prod DB** from your laptop. Migrations run in the prod container via its `CMD`.
- **Don't commit `.env`.** It's gitignored but double-check `git status` before committing.
- **Don't test the `sendVoice` action** against your personal number with a voice that takes 30 seconds to synthesize. Use short text for testing.
- **Don't run a backfill against prod Evolution from your dev backend** unless you want your local DB to grow to 11k+ messages. It's fine but slow.

## Useful dev scripts

Put these in your shell init for convenience:

```bash
# ~/.zshrc or ~/.bashrc
alias zap="cd ~/Desktop/www/zaphelper"
alias zapbe="cd ~/Desktop/www/zaphelper/backend && npm run dev"
alias zapweb="cd ~/Desktop/www/zaphelper/web && npm run dev"
alias zapdb="cd ~/Desktop/www/zaphelper/backend && DATABASE_URL='postgresql://macbook@localhost:5432/zaphelper' npx prisma studio"
alias zaplog="curl -sk https://zaphelper.maverstudio.com/health | jq"
```

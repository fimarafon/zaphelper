# zaphelper

Personal WhatsApp assistant. Live at **https://zaphelper.maverstudio.com**.

Owner sends slash commands (`/statustoday`, `/reminder`, `/schedule`) in their own WhatsApp self-chat. The bot parses messages from a specific lead-tracking group, aggregates them, replies with summaries, and runs scheduled tasks (daily reports, reminders, webhooks, voice notes).

## Stack

- **Backend:** Node 20 + TypeScript + Fastify + Prisma + PostgreSQL
- **Frontend:** Vite + React + Tailwind + TanStack Query
- **WhatsApp integration:** [Evolution API](https://github.com/EvolutionAPI/evolution-api) (Baileys under the hood)
- **Deploy:** Docker Compose via EasyPanel (3 services: postgres, backend, web)

## Features

- **Real-time lead reports** via slash commands in self-chat:
  - `/statustoday`, `/statusyesterday`, `/statusweek`, `/statusmonth`, `/status7days`
  - `/status04/09` / `/status04/03to04/09` / `/status2026-04-09` — any date or range
  - `/audit` — transparency about which messages were not counted as leads
- **On-demand data sync** — every `/status*` command forces a fresh Evolution API pull before querying, so results always reflect the latest state (even if a webhook dropped)
- **Reminders** via `/reminder 2026-04-14 09:00 Call Jack`
- **Scheduled tasks** via `/schedule daily 18:00 /statustoday` (cron-based, pluggable action types)
- **4 built-in action types:** sendText, runCommand, webhook, sendVoice (ElevenLabs)
- **Admin dashboard** at `zaphelper.maverstudio.com` for monitoring, QR connection, creating schedules, auditing messages
- **Lead parser** with fuzzy source detection (Thumbtack / Angi / Yelp / Google / Facebook / Referral + typo tolerance)
- **LID → human name resolution** for WhatsApp group participants
- **Incremental sync** safety net (runs every 5 minutes in the background + on-demand before every command) so messages dropped during container restarts are always caught

## Login

- **URL:** https://zaphelper.maverstudio.com
- **Username:** `filipeadmin`
- **Password:** set via `ADMIN_PASSWORD_HASH` env var on EasyPanel (bcrypt)

## Quick start (local dev)

```bash
git clone https://github.com/fimarafon/zaphelper.git
cd zaphelper
npm install

# Start postgres
brew services start postgresql@16 && createdb zaphelper
# OR: docker run -d --name zaphelper-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16-alpine

# Migrations
cd backend
DATABASE_URL="postgresql://$(whoami)@localhost:5432/zaphelper" npx prisma migrate deploy
npx prisma generate

# Fill in .env (copy from .env.example)
cp ../.env.example ../.env

# Run backend + web
npm run dev            # in backend/
cd ../web && npm run dev   # in another terminal
```

See [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) for full setup.

## Documentation

Complete, cross-linked documentation for humans and AI assistants alike:

| Doc | What it covers |
|---|---|
| [AUDIT.md](./docs/AUDIT.md) | Security & reliability risk assessment with P0/P1/P2 priorities |
| [ARCHITECTURE.md](./docs/ARCHITECTURE.md) | High-level dataflow, containers, invariants, source layout |
| [DATA-MODEL.md](./docs/DATA-MODEL.md) | Every Prisma model explained with rationale |
| [COMMANDS.md](./docs/COMMANDS.md) | Every slash command with examples + how to add new ones |
| [ACTIONS.md](./docs/ACTIONS.md) | Pluggable scheduled task actions + adding new types |
| [EVOLUTION-INTEGRATION.md](./docs/EVOLUTION-INTEGRATION.md) | Evolution API endpoints, LID quirk, workarounds |
| [DEPLOYMENT.md](./docs/DEPLOYMENT.md) | End-to-end EasyPanel deploy + env vars + Dockerfiles |
| [DEVELOPMENT.md](./docs/DEVELOPMENT.md) | Local dev setup, daily workflow, debugging techniques |
| [RUNBOOK.md](./docs/RUNBOOK.md) | Common problems with step-by-step fixes |
| [REBUILDING.md](./docs/REBUILDING.md) | Zero-to-working rebuild guide for AI or new dev |

**If you're an AI tasked with working on this project:** start by reading ARCHITECTURE.md, then the doc relevant to your task. REBUILDING.md is the densest reference if you need to recreate the system from scratch.

## Source layout

```
zaphelper/
├── backend/                    — Fastify API + Prisma + scheduler
│   ├── prisma/                 — schema + migrations
│   └── src/
│       ├── server.ts           — entrypoint, wires everything
│       ├── config.ts           — zod-validated env
│       ├── evolution/          — Evolution API client + webhook types
│       ├── routes/             — HTTP routes (auth, webhook, instance, messages, commands, reminders, schedules)
│       ├── commands/           — slash commands + registry
│       ├── actions/            — scheduled task actions + registry
│       ├── services/           — MessageIngest, CommandDispatcher, Scheduler, ScheduledTaskRunner, IncrementalSync, etc.
│       ├── middleware/         — auth, rate limit
│       └── utils/              — phone, dates, format helpers
├── web/                        — Vite + React dashboard
│   ├── src/
│   │   ├── pages/              — Login, Dashboard, Messages, Commands, Reminders, Schedules
│   │   ├── components/
│   │   └── api/                — fetch client + TanStack Query hooks
│   └── nginx.conf.template     — reverse proxy for /api + /webhook
├── docs/                       — all the docs linked above
├── docker-compose.yml
└── .env.example
```

## Deployment

Deploys to EasyPanel on push to `main`. Three services share the `studio` project on `https://easypanel.maverstudio.com`:

- `studio_zaphelper-postgres` — persistent data
- `studio_zaphelper-backend` — Fastify (internal only)
- `studio_zaphelper-web` — nginx serving SPA + proxying `/api` and `/webhook` to backend. Only public service.

See [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) for the complete checklist.

## Status as of 2026-04-11

- ✅ All core features working end-to-end in production
- ✅ Webhook receives events, commands reply in self-chat within seconds
- ✅ 13 slash commands, 4 action types, 6 database models
- ✅ On-demand sync guarantees `/status*` always reflects latest state (no 5-min lag)
- ✅ Message edits (`MESSAGES_UPDATE` webhook events) applied to existing rows
- ✅ LID → human name resolution via import from legacy instance
- ✅ Rate-limited login, deep healthcheck, graceful shutdown, auto-disable failing tasks
- ✅ 10 parser unit tests passing

See [docs/AUDIT.md](./docs/AUDIT.md) for the list of known risks and their priorities.

## License

Private. Do not redistribute.

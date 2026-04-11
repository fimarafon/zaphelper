# zaphelper — Architecture

**Audience:** anyone (human or AI) who needs to understand how zaphelper works well enough to modify it, debug it, or rebuild it from scratch.

## What it is

zaphelper is a personal WhatsApp assistant. The owner (Filipe) scans a QR code with his phone, linking a "ghost device" to his WhatsApp account via [Evolution API](https://github.com/EvolutionAPI/evolution-api). That ghost device receives every message Filipe's phone receives — group chats, DMs, self-chat — and forwards them to zaphelper's backend as webhooks.

From the owner's perspective, the main interaction is **slash commands sent in his own self-chat**. When he types `/statustoday` in "Message yourself", zaphelper intercepts the message, runs a command, and replies in the same self-chat.

It also:

- Backfills historical messages from Evolution's own database (because Evolution doesn't retry dropped webhooks)
- Parses group messages from a specific lead-tracking group ("Be Home Leads Scheduled") to produce reports (`/statustoday`, `/statusweek`, `/statusmonth`, etc.)
- Runs scheduled tasks on a cron schedule (daily reports, webhook pings, reminders)
- Exposes a small admin dashboard at `https://zaphelper.maverstudio.com` for monitoring

## Big-picture dataflow

```
┌──────────────┐
│  Filipe's    │
│  WhatsApp    │──┐
│  phone       │  │   ghost device (Baileys session)
└──────────────┘  │
                  ▼
         ┌──────────────────┐
         │  Evolution API   │  runs at evolution.maverstudio.com
         │  (Baileys wrap)  │  stores all messages in its own Postgres
         └────────┬─────────┘
                  │
           1. webhook (real-time)
           2. /chat/findMessages (backfill)
                  │
                  ▼
         ┌──────────────────┐    ┌───────────────┐
         │  zaphelper       │◄──►│  zaphelper    │
         │  backend         │    │  Postgres     │
         │  (Fastify)       │    │  (Prisma)     │
         └────────┬─────────┘    └───────────────┘
                  │
          ┌───────┼────────┐
          ▼       ▼        ▼
       reply   reply   scheduled tasks fire
       (self)  (self)  (sendText / runCommand /
                        webhook / sendVoice)
                  │
                  ▼
         ┌──────────────────┐
         │  Web dashboard   │  https://zaphelper.maverstudio.com
         │  (Vite / React)  │  admin view of messages, commands,
         │                  │  reminders, schedules
         └──────────────────┘
```

## The 4 data paths

### Path 1 — Real-time ingest (webhook)

1. A WhatsApp message arrives on Filipe's phone
2. His phone forwards it to every linked device, including the Baileys session managed by Evolution API
3. Evolution API parses it and fires a POST at `https://zaphelper.maverstudio.com/webhook` with an `EvolutionWebhookPayload`
4. nginx (the `web` container) proxies the POST to the `backend` container's `POST /webhook`
5. `routes/webhook.ts` validates the body with zod, branches by event type
6. For `MESSAGES_UPSERT`: `MessageIngest.ingest()` extracts content, dedupes by `waMessageId` unique constraint, inserts into the `Message` table
7. If `isFromMe && remoteJid === selfJid && content startsWith "/"`, fire-and-forget dispatch to `CommandDispatcher`

### Path 2 — Backfill / incremental sync (safety net)

Webhooks are fire-and-forget; Evolution doesn't retry on backend downtime. `IncrementalSync` runs every 5 minutes in the background:

1. `fetchAllGroups(withParticipants=true)` → build LID → phone map
2. `fetchAllContacts()` → build phone → pushName map
3. Walk the first N pages of `/chat/findMessages` (newest first)
4. For each record, `MessageIngest.ingestRaw()` extracts + dedupes + inserts
5. Short-circuit as soon as a full page yields zero new messages (steady-state cost: ~1 Evolution API call every 5 min)

Also exposed as `POST /api/instance/backfill` for a manual full-walk, useful after a long downtime.

### Path 3 — Commands

Triggered by Path 1 when the user sends `/something` in self-chat.

1. `CommandDispatcher.dispatch()` receives the saved `IngestedMessage`
2. `registry.parseCommandLine(input)` handles both `/status 04/09` and `/status04/09` (no space) by longest-prefix match
3. Looks up the `Command` in `CommandRegistry`
4. Builds a `CommandContext` with injected services (prisma, evolution, scheduler, config, self identity, etc.)
5. Runs `cmd.execute(ctx)` → returns `{ success, reply, error? }`
6. Logs to `CommandLog` table
7. Sends the reply via `evolution.sendText(selfPhone, reply)` — lands back in the user's self-chat

Also runnable inline via `POST /api/commands/run` for testing from the dashboard (same code path, but doesn't send via Evolution unless the command itself does).

### Path 4 — Scheduled tasks

Runs independently from commands.

1. `ScheduledTaskRunner` starts on boot, reads all enabled `ScheduledTask` rows
2. For cron tasks: registers with `node-cron` (validated syntax + timezone)
3. For one-shot tasks: schedules via `setTimeout` (with sweep for delays > 24.8 days)
4. When a task fires: `fireTask()` resolves the action from `ActionRegistry` by type name, validates the payload with zod, runs `action.execute(ctx, payload)` with a 60s hard timeout
5. Updates `lastFiredAt`, `runCount`, `failureCount`, `lastError`, `lastResult`
6. Auto-disables cron tasks after 10 consecutive failures (and notifies the user via self-chat)
7. Recomputes `nextFireAt` with `cron-parser` for proper tz-aware scheduling

Actions (pluggable, live in `src/actions/`):

- **sendText**: `evolution.sendText(to, text)` — 90% of cases
- **runCommand**: calls back into `CommandDispatcher.runInline(input)` and optionally delivers the result to self-chat. This is how `/statusweek` can be scheduled to auto-run every Monday.
- **webhook**: `fetch()` any URL with method/body/headers
- **sendVoice**: ElevenLabs text-to-speech → base64 audio → `evolution.sendMedia()` (requires `ELEVENLABS_API_KEY`)

## Containers

Deployed on EasyPanel (Traefik proxy) inside a single project called `studio`:

| Service | Image | Role |
|---|---|---|
| `studio_zaphelper-postgres` | postgres:16-alpine | Persistent data store. Single replica. |
| `studio_zaphelper-backend` | custom (backend/Dockerfile) | Fastify app, port 3000 internal |
| `studio_zaphelper-web` | custom (web/Dockerfile, nginx) | Vite SPA + reverse proxy, port 80 exposed via Traefik to `zaphelper.maverstudio.com` |

The `web` container is the only one with a public domain. It proxies:

- `/api/*` → backend:3000
- `/webhook` → backend:3000/webhook
- Everything else → static SPA files

This means the backend is never directly reachable from the internet, which is a nice security property.

## Source layout

```
zaphelper/
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma           — data model, 6 models + 5 enums
│   │   └── migrations/             — version-controlled SQL migrations
│   ├── src/
│   │   ├── server.ts               — entrypoint: wires everything together
│   │   ├── config.ts               — zod-validated env loader
│   │   ├── prisma.ts               — singleton Prisma client
│   │   ├── logger.ts               — pino factory
│   │   ├── evolution/
│   │   │   ├── client.ts           — typed Evolution API wrapper
│   │   │   ├── types.ts            — Evolution response types
│   │   │   └── webhook-types.ts    — zod schema for webhook payloads
│   │   ├── routes/
│   │   │   ├── auth.ts             — /api/auth/login, logout, me
│   │   │   ├── webhook.ts          — POST /webhook (public)
│   │   │   ├── instance.ts         — /api/instance/* (status, connect, backfill, names)
│   │   │   ├── messages.ts         — /api/messages, /api/messages/chats
│   │   │   ├── commands.ts         — /api/commands/* (registry, logs, run)
│   │   │   ├── reminders.ts        — /api/reminders/*
│   │   │   └── schedules.ts        — /api/schedules/*
│   │   ├── commands/
│   │   │   ├── types.ts            — Command interface
│   │   │   ├── registry.ts         — static list + buildCommandList() factory
│   │   │   ├── status-*.command.ts — /statustoday, /statusyesterday, /status7days, /statusweek, /statusmonth
│   │   │   ├── status.command.ts   — /status <date|range>
│   │   │   ├── status-shared.ts    — buildStatusReply() used by all status commands
│   │   │   ├── audit.command.ts    — /audit — transparency on skipped messages
│   │   │   ├── reminder.command.ts — /reminder
│   │   │   ├── reminders.command.ts — /reminders
│   │   │   ├── schedule.command.ts  — /schedule (factory fn, needs taskService)
│   │   │   ├── schedules.command.ts — /schedules, /unschedule (factory fn)
│   │   │   └── help.command.ts      — /help
│   │   ├── actions/
│   │   │   ├── types.ts            — Action interface + ActionContext
│   │   │   ├── registry.ts         — ActionRegistry + validate()
│   │   │   ├── send-text.action.ts
│   │   │   ├── run-command.action.ts
│   │   │   ├── webhook.action.ts
│   │   │   └── send-voice.action.ts
│   │   ├── services/
│   │   │   ├── message-ingest.ts   — MessageIngest (webhook + backfill ingest)
│   │   │   ├── command-dispatcher.ts — CommandDispatcher (dispatch + runInline)
│   │   │   ├── scheduler.ts        — Scheduler (reminders only)
│   │   │   ├── scheduled-task-runner.ts — ScheduledTaskRunner (generic tasks)
│   │   │   ├── scheduled-task-service.ts — ScheduledTaskService (CRUD + validation)
│   │   │   ├── incremental-sync.ts — IncrementalSync (safety net polling)
│   │   │   ├── self-identity.ts    — SelfIdentity (know the user's JID)
│   │   │   └── lead-parser.ts      — parseLead() + detectSource() fuzzy match
│   │   ├── middleware/
│   │   │   ├── auth.ts             — JWT cookie verification + requireAuth()
│   │   │   └── rate-limit.ts       — in-memory sliding window limiter
│   │   └── utils/
│   │       ├── phone.ts            — jid helpers
│   │       ├── dates.ts            — TZ-aware day/week/month math + parseStatusRange()
│   │       └── format.ts           — formatStatusReply() + aggregateLeads()
│   ├── Dockerfile
│   └── package.json
├── web/
│   ├── src/
│   │   ├── main.tsx                — router root
│   │   ├── App.tsx                 — route config
│   │   ├── components/
│   │   │   ├── Layout.tsx          — nav + header
│   │   │   ├── QrCode.tsx          — QR display
│   │   │   └── ConnectionBadge.tsx
│   │   ├── pages/
│   │   │   ├── Login.tsx
│   │   │   ├── Dashboard.tsx       — connection status, QR, last commands
│   │   │   ├── Messages.tsx        — message browser
│   │   │   ├── Commands.tsx        — test runner + registry + logs
│   │   │   ├── Reminders.tsx
│   │   │   └── Schedules.tsx       — tasks table + create form
│   │   └── api/
│   │       ├── client.ts           — fetch wrapper with cookies
│   │       └── hooks.ts            — TanStack Query hooks
│   ├── nginx.conf.template         — envsubst'd at container start
│   ├── Dockerfile
│   └── package.json
├── docs/
│   ├── AUDIT.md                    — risk audit + P0/P1/P2
│   ├── ARCHITECTURE.md             — this file
│   ├── DATA-MODEL.md               — Prisma schema walkthrough
│   ├── COMMANDS.md                 — every /command explained
│   ├── ACTIONS.md                  — scheduled task actions
│   ├── EVOLUTION-INTEGRATION.md    — Evolution API quirks & LID issue
│   ├── DEPLOYMENT.md               — EasyPanel deploy steps
│   ├── RUNBOOK.md                  — common problems & fixes
│   ├── DEVELOPMENT.md              — local dev setup
│   └── REBUILDING.md               — start from scratch guide
├── docker-compose.yml
├── .env.example
└── README.md
```

## Request lifecycle diagrams

### Webhook (path 1)

```
Evolution API
    │  POST https://zaphelper.maverstudio.com/webhook
    │  Content-Type: application/json
    │  {event, instance, data: {key, message, pushName, messageTimestamp, ...}}
    ▼
Traefik (EasyPanel)
    │  terminates TLS (Let's Encrypt cert)
    ▼
nginx (web container)
    │  location /webhook → proxy_pass http://studio_zaphelper-backend:3000/webhook
    ▼
Fastify (backend container)
    │  addContentTypeParser — accepts empty JSON body
    │  bodyLimit 5 MB
    │  cookie + cors plugins
    │  preHandler: registerAuthHook (attaches authUser if cookie)
    ▼
POST /webhook handler (routes/webhook.ts)
    │  zod validate → branch by event type
    ▼
MessageIngest.ingest()
    │  extractContent() → MessageType + content
    │  jidToChatId(), isGroupJid()
    │  determine isSelfChat from selfIdentity
    │  resolve senderName from nameCache (Config table) + data.pushName
    │  prisma.message.create() — catches P2002 duplicate
    ▼
If isSelfCommand:
    setImmediate(() => dispatcher.dispatch(saved))
reply: { ok: true }
```

### `/statustoday` end-to-end

```
Filipe types /statustoday in his WhatsApp self-chat
    │
    ▼  [Path 1 — real-time webhook]
Message stored in DB with isSelfChat=true
    │
    ▼  [setImmediate fire-and-forget]
CommandDispatcher.dispatch(message)
    │  registry.parseCommandLine("statustoday") → { cmd: statusTodayCommand, rawInput: "" }
    │  selfJid + selfPhone from SelfIdentity
    │  prisma.commandLog.create({ status: "SUCCESS" })
    ▼
statusTodayCommand.execute(ctx)
    │  start = startOfTodayInTz(now, "America/Los_Angeles")
    ▼
buildStatusReply({ label: "Today", start, end: now })
    │  prisma.message.findMany where chatName contains "Be Home Leads Scheduled"
    │                              AND timestamp in [start, end]
    │                              AND messageType = TEXT
    │  for each msg: parseLeadWithReason() → parsed or skipReason
    │  aggregateLeads(leads) → { byPerson, bySource }
    │  formatStatusReply({ byPerson, bySource, skipped, skippedByReason })
    │  returns { success: true, reply: "📊 Scheduled Leads — Today...\n..." }
    ▼
evolution.sendText(selfPhone, reply)
    │  POST https://evolution.maverstudio.com/message/sendText/zaphelper-main
    │  { number: "16198886149", text: "📊 Scheduled Leads — Today..." }
    ▼
Evolution API delivers to Filipe's WhatsApp
    │  message appears in the self-chat
    ▼
prisma.commandLog.update({ output: reply, durationMs, status: SUCCESS })
```

## Key invariants

These things must always be true; breaking them causes bugs.

1. **`waMessageId` is unique.** The webhook deduper relies on this. The Postgres UNIQUE index is the source of truth — never bypass it with raw SQL.

2. **`isSelfChat` is computed once at ingest time**, not queried from the current `selfJid`. Rationale: if the user ever changes phones, old messages should remain classified as of the time they were received.

3. **`TZ` env var is the one true timezone.** All day/week/month math goes through `date-fns-tz` with this value. Never use `new Date().setHours(0)` on raw Dates.

4. **Commands are delivered via self-chat only.** The webhook handler only dispatches commands when `isSelfChat && fromMe && content.startsWith("/")`. A message from a third party starting with `/` is stored but **never triggers a command**.

5. **The command dispatcher is fire-and-forget.** The webhook returns 200 immediately. Command execution happens via `setImmediate`. This prevents Evolution's webhook timeout from killing long commands.

6. **Scheduled tasks are idempotent on registration.** Re-registering the same task is safe — the runner unregisters any existing cron/timer for that ID first.

7. **Reminders that fired during downtime are fired once on next boot**, prefixed with `⏰ [Missed reminder]`. This is intentional and documented.

8. **Incremental sync is idempotent.** Running it 100 times in a row produces the same result as running it once — duplicates are caught by the unique constraint.

9. **LID → name resolution lives in the `Config` table** with keys `name:<phone>`. The in-memory cache in `MessageIngest` is built from this on first use and refreshed after any `/api/instance/name-mapping` or `/api/instance/import-names` call.

10. **nginx is the only public entry.** The backend container is NEVER exposed directly. All external requests go through `web` → nginx → backend over the internal Docker network.

## How extensibility works

### Adding a new command

1. Create `backend/src/commands/<name>.command.ts`
2. Export a `Command` object with `name`, `description`, `usage`, `execute(ctx)`
3. If it needs a runtime service (like `taskService`), use a factory function that takes deps and returns the command; add it to `buildCommandList({ ... })`
4. Otherwise add it to `staticCommands[]`
5. Typecheck + push; EasyPanel rebuilds automatically

### Adding a new action type for scheduled tasks

1. Create `backend/src/actions/<name>.action.ts`
2. Export an `Action<Payload>` with `type`, `description`, `validatePayload(payload: unknown): void`, `execute(ctx, payload)`
3. Add a zod schema for the payload so validation is bulletproof
4. Register in `backend/src/actions/registry.ts` → `allActions[]`
5. The dashboard form's dropdown will automatically include it

### Adding a new webhook source

Out of scope for now — Evolution is the only WhatsApp integration. If you ever want to add, say, Telegram:

1. Create a new ingest service (e.g. `telegram-ingest.ts`)
2. Add a new webhook route (`/webhook/telegram`)
3. Reuse `MessageIngest` by adding a telegram ingest method that maps telegram updates to the common Message shape
4. Route dispatcher logic needs to know "am I in a self-chat?" — for Telegram that's `chat.type === "private" && from.id === me.id`

## Non-goals

Things zaphelper is deliberately NOT:

- **A CRM.** It stores messages but doesn't track leads, deals, pipeline, etc. (Markar does that.)
- **A multi-user SaaS.** One user (Filipe), one WhatsApp account, one dashboard login.
- **A WhatsApp sender.** It only sends messages to the owner's own chat or to targets the user explicitly schedules.
- **A replacement for Evolution API.** It's a thin consumer layer on top of Evolution's rich API.
- **Highly available.** Single-container, single-DB, single-VPS. The incremental sync + healthcheck make it resilient but not fault-tolerant.

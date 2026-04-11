# zaphelper — Rebuilding from scratch

This document is a **complete guide for an AI (or human) to recreate zaphelper from zero**, either because (a) the original code was lost, (b) you want to port it to another stack, or (c) you want a deep understanding of what everything does.

If you read this doc top-to-bottom, you should have everything you need to rebuild the system without any gaps.

## 0. What you're building

A personal WhatsApp assistant with three core features:

1. **Slash commands in self-chat** — the user types `/statustoday` in their WhatsApp "message yourself" chat, the bot parses it and replies with a summary.
2. **Lead parsing from a group** — messages in a specific WhatsApp group that follow a lead format (name, phone, scheduled time, source) are extracted and aggregated.
3. **Scheduled tasks** — cron or one-shot tasks that fire actions (send text, run command, call webhook, synthesize voice).

Plus an admin dashboard (web SPA) for monitoring and configuration.

## 1. Required services

You need three running services before any code runs:

### 1.1 PostgreSQL 16

Why: primary data store. Everything persists here.

Schema: see [DATA-MODEL.md](./DATA-MODEL.md) for all 6 models. Tables:

- `Message` — all WhatsApp messages
- `Reminder` — one-shot reminders for /reminder command
- `CommandLog` — audit trail
- `Config` — key-value store (self_jid, name mappings)
- `Instance` — the WhatsApp instance metadata
- `ScheduledTask` — generic cron/one-shot scheduled jobs

Use Prisma as the ORM. Schema file goes in `backend/prisma/schema.prisma`.

### 1.2 Evolution API

Why: this is the WhatsApp integration layer. It wraps [Baileys](https://github.com/WhiskeySockets/Baileys), provides a REST API to list/send messages, and fires webhooks on new events.

- Run in Docker: `atendai/evolution-api:2.3.7` (or latest stable)
- Needs its own Postgres (separate from zaphelper's)
- Authenticated via `AUTHENTICATION_API_KEY` env var
- Each WhatsApp account is an "instance" — create one for zaphelper, scan a QR once to pair
- The instance has a `webhook` field pointing at your zaphelper backend

Key endpoints zaphelper uses — full list in [EVOLUTION-INTEGRATION.md](./EVOLUTION-INTEGRATION.md):

- `POST /instance/create` — initial setup
- `GET /instance/fetchInstances` — list/inspect
- `GET /instance/connectionState/{name}` — is it connected?
- `GET /instance/connect/{name}` — get fresh QR
- `POST /message/sendText/{name}` — send messages
- `POST /chat/findMessages/{name}` — paginated historical read (used for backfill + sync)
- `GET /group/fetchAllGroups/{name}?getParticipants=true` — LID → phone resolution
- `POST /chat/findContacts/{name}` — phone → pushName mapping
- `POST /chat/fetchProfile/{name}` — per-number profile lookup
- Webhook: Evolution posts to your URL on `MESSAGES_UPSERT` and `CONNECTION_UPDATE` events

### 1.3 zaphelper (backend + web)

What you're building. Runs in 2 containers:

- **backend** (Fastify, Node 20, TypeScript) on port 3000
- **web** (nginx serving a Vite SPA + reverse-proxying `/api` and `/webhook` to backend) on port 80

Only `web` needs to be publicly accessible. The backend talks to Postgres and Evolution directly.

## 2. Tech stack

### Backend

| Package | Purpose | Why this one |
|---|---|---|
| `fastify` ^4 | HTTP server | Fast, type-safe, plugin ecosystem |
| `@prisma/client` ^5 | ORM | Best TS DX, migrations as code |
| `pino` + `pino-pretty` | Logger | Fast, structured, ecosystem-standard |
| `zod` | Runtime validation | Use everywhere: env, payloads, webhook body |
| `bcryptjs` | Password hashing | Pure JS, no native bindings |
| `jsonwebtoken` | Auth cookies | Standard, stateless |
| `@fastify/cookie` | Cookie middleware | Pairs with jsonwebtoken |
| `@fastify/cors` | CORS middleware | Needed for dev (web → backend across ports) |
| `node-cron` | Cron scheduler | Simple, tz-aware |
| `cron-parser` | Cron expression parsing | Accurate `nextFireAt` computation |
| `date-fns` + `date-fns-tz` | Timezone-aware date math | Standard |
| `dotenv` | Env loading in dev | Prod uses container env |
| `tsx` | Dev runner | Fast TS execution without build step |
| `vitest` | Tests | Fast, good DX |

### Frontend

| Package | Purpose |
|---|---|
| `react` ^18 | UI framework |
| `react-router-dom` ^6 | Client-side routing |
| `@tanstack/react-query` ^5 | Data fetching + cache |
| `tailwindcss` ^3 | Styling |
| `vite` ^5 | Dev server + build |
| `typescript` ^5 | Type checking |

### Infrastructure

- **Docker** — 2 images (backend, web) + Postgres
- **nginx** (alpine) — serving SPA + reverse proxy
- **EasyPanel** (or any Docker orchestrator) — runs compose, handles TLS, domain routing
- **Let's Encrypt** via Traefik — automatic SSL certs

## 3. Source code structure

```
zaphelper/
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma
│   │   └── migrations/
│   ├── src/
│   │   ├── server.ts               — entrypoint, wires everything
│   │   ├── config.ts               — zod-validated env loader
│   │   ├── logger.ts               — pino factory
│   │   ├── prisma.ts               — Prisma singleton
│   │   ├── evolution/
│   │   │   ├── client.ts           — typed Evolution API wrapper
│   │   │   ├── types.ts            — response types
│   │   │   └── webhook-types.ts    — zod schema for webhook payloads
│   │   ├── routes/                 — Fastify plugins, one per namespace
│   │   ├── commands/               — slash commands, one per file
│   │   ├── actions/                — scheduled task actions
│   │   ├── services/               — business logic classes
│   │   ├── middleware/             — auth, rate limit
│   │   └── utils/                  — phone, dates, format
│   ├── Dockerfile
│   └── package.json
├── web/
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── pages/
│   │   ├── components/
│   │   └── api/
│   ├── nginx.conf.template
│   ├── Dockerfile
│   └── package.json
├── docker-compose.yml
├── .env.example
└── package.json                    — root workspaces config
```

Full tree with file descriptions in [ARCHITECTURE.md § Source layout](./ARCHITECTURE.md#source-layout).

## 4. Prisma schema (copy this verbatim)

This is the exact schema, with all indexes and invariants. Save as `backend/prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Message {
  id          String      @id @default(cuid())
  waMessageId String      @unique
  chatId      String
  chatName    String?
  senderPhone String?
  senderName  String?
  content     String
  rawMessage  Json
  messageType MessageType
  isGroup     Boolean     @default(false)
  isFromMe    Boolean     @default(false)
  isSelfChat  Boolean     @default(false)
  timestamp   DateTime
  createdAt   DateTime    @default(now())
  commandLogs CommandLog[]

  @@index([chatId, timestamp])
  @@index([isSelfChat, isFromMe, timestamp])
  @@index([chatName])
  @@index([timestamp])
}

enum MessageType { TEXT IMAGE AUDIO VIDEO DOCUMENT STICKER CONTACT LOCATION OTHER }

model Reminder {
  id           String         @id @default(cuid())
  scheduledAt  DateTime
  message      String
  status       ReminderStatus @default(PENDING)
  createdByCmd String?
  createdAt    DateTime       @default(now())
  sentAt       DateTime?
  error        String?
  @@index([status, scheduledAt])
}

enum ReminderStatus { PENDING SENT MISSED CANCELLED FAILED }

model CommandLog {
  id         String        @id @default(cuid())
  command    String
  args       String?
  rawInput   String
  messageId  String?
  message    Message?      @relation(fields: [messageId], references: [id], onDelete: SetNull)
  output     String?
  status     CommandStatus
  error      String?
  executedAt DateTime      @default(now())
  durationMs Int?
  @@index([executedAt])
  @@index([command, executedAt])
}

enum CommandStatus { SUCCESS FAILURE NOT_FOUND }

model Config {
  key       String   @id
  value     String
  updatedAt DateTime @updatedAt
}

model Instance {
  id              String         @id @default(cuid())
  name            String         @unique
  phoneNumber     String?
  ownerJid        String?
  status          InstanceStatus @default(DISCONNECTED)
  lastConnectedAt DateTime?
  lastSeenAt      DateTime?
  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt
}

enum InstanceStatus { DISCONNECTED CONNECTING CONNECTED ERROR }

model ScheduledTask {
  id              String   @id @default(cuid())
  name            String
  enabled         Boolean  @default(true)
  cronExpression  String?
  fireAt          DateTime?
  actionType      String
  actionPayload   Json
  lastFiredAt     DateTime?
  nextFireAt      DateTime?
  lastError       String?
  lastResult      String?
  runCount        Int      @default(0)
  failureCount    Int      @default(0)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@index([enabled, nextFireAt])
  @@index([enabled, fireAt])
}
```

Run `prisma migrate dev --name init` (and any subsequent migrations).

## 5. Core domain logic

### 5.1 Message ingest

Two code paths, both ending in a `prisma.message.create()`:

**Real-time (webhook):** `MessageIngest.ingest(webhookData)`

```typescript
async ingest(data: EvolutionMessagesUpsertData): Promise<IngestResult> {
  await this.ensureNameCache();

  const key = data.key;
  if (!key?.id) return { saved: null, duplicate: false, isSelfCommand: false };

  const remoteJid = key.remoteJid;
  const isGroup = isGroupJid(remoteJid);  // endsWith "@g.us"
  const fromMe = Boolean(key.fromMe);

  const { content, messageType } = extractContent(data.message ?? {});
  const chatId = jidToChatId(remoteJid);
  const senderJidRaw = isGroup ? key.participant : remoteJid;
  const senderPhone = senderJidRaw ? jidToChatId(senderJidRaw) : null;

  const chatName = resolveChatName(data, isGroup);
  const timestamp = resolveTimestamp(data.messageTimestamp);

  const selfJid = this.selfIdentity.getJid();
  const isSelfChat = fromMe && selfJid !== null && remoteJid === selfJid;

  // Resolve senderName: manual mapping > pushName (if non-numeric) > null
  let resolvedSenderName: string | null = null;
  if (senderPhone) {
    const manualName = this.nameCache.get(senderPhone);
    if (manualName) resolvedSenderName = manualName;
  }
  if (!resolvedSenderName && data.pushName && !/^\d+$/.test(data.pushName)) {
    resolvedSenderName = data.pushName;
  }

  try {
    const saved = await this.prisma.message.create({
      data: { waMessageId: key.id, chatId, chatName, senderPhone, senderName: resolvedSenderName,
              content, rawMessage: data, messageType, isGroup, isFromMe: fromMe, isSelfChat, timestamp }
    });
    const isSelfCommand = isSelfChat && content.trim().startsWith("/");
    return { saved, duplicate: false, isSelfCommand };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { saved: null, duplicate: true, isSelfCommand: false };
    }
    throw err;
  }
}
```

**Backfill/sync:** `MessageIngest.ingestRaw(record, resolver)` — similar but takes a raw Evolution record (from `/chat/findMessages`) plus a resolver object with chatNameMap + lidToPhone + phoneToName, and does LID → phone → name resolution for historical messages where pushName is numeric.

### 5.2 Content extraction

```typescript
function extractContent(body: EvolutionMessageBody): { content: string; messageType: MessageType } {
  if (body.conversation) return { content: body.conversation, messageType: "TEXT" };
  if (body.extendedTextMessage?.text) return { content: body.extendedTextMessage.text, messageType: "TEXT" };
  if (body.imageMessage) return { content: body.imageMessage.caption ?? "[Image]", messageType: "IMAGE" };
  if (body.audioMessage) return { content: "[Audio]", messageType: "AUDIO" };
  if (body.videoMessage) return { content: body.videoMessage.caption ?? "[Video]", messageType: "VIDEO" };
  if (body.documentMessage) return { content: `[Document: ${body.documentMessage.fileName ?? "file"}]`, messageType: "DOCUMENT" };
  if (body.stickerMessage) return { content: "[Sticker]", messageType: "STICKER" };
  if (body.contactMessage) return { content: `[Contact: ${body.contactMessage.displayName ?? "contact"}]`, messageType: "CONTACT" };
  if (body.locationMessage) return { content: "[Location]", messageType: "LOCATION" };
  return { content: "[Unsupported message]", messageType: "OTHER" };
}
```

### 5.3 Lead parser

Flexible line-based parser, NOT a single regex. Handles many format variations.

Interface:
```typescript
interface ParsedLead {
  name: string | null;
  phone: string | null;
  address: string | null;
  scheduledAt: Date | null;
  project: string | null;
  source: string | null;
  rawLines: string[];
}

type SkipReason = "too_short" | "no_signal" | "empty" | "parsed";

function parseLeadWithReason(content: string): { lead: ParsedLead | null; skipReason: SkipReason };
function parseLead(content: string): ParsedLead | null; // thin wrapper
```

Algorithm:

1. Split content by newlines, trim, filter empty → `lines[]`
2. If `lines.length === 0` → `{ lead: null, skipReason: "empty" }`
3. If `lines.length < 2` → `{ lead: null, skipReason: "too_short" }`
4. **Source detection** (multi-strategy):
   - Try last line → `detectSource(lines[n-1])`
   - Try penultimate line → `detectSource(lines[n-2])`
   - Try any line starting with `Source:` / `Fonte:` / `From:` / `Origem:`
   - Last resort: scan the whole message
5. **Other field extraction** — walk each line and match:
   - Key-value `^([A-Za-z ]+):\s*(.+)$` for Name, Phone, Address, Scheduled, Project
   - Loose phone match: `(\+?\d[\d\s().-]{7,}\d)` on lines that are mostly just a phone
   - Address heuristic: `^\d+\s+[A-Za-z]` without `:`
   - Name heuristic: title-case multi-word line
6. Return `null` if no name AND no phone AND no scheduledAt (not enough signal)

**detectSource** is a fuzzy matcher with 6 canonical sources and ~10 aliases each, plus Levenshtein distance fuzzy matching for typos.

Canonical sources:
- **Thumbtack** — aliases: thumbtack, thumbtac, thumbtak, thumback, thumb tack, tumbtack, tumtack, ...
- **Angi** — aliases: angi, angie, angis, angi's, angie's list, angieslist, ...
- **Yelp** — aliases: yelp, yellp, yepl, ...
- **Google** — aliases: google, googl, goolge, gogle, google ads, google lsa, lsa, gads, gmb, ...
- **Facebook** — aliases: facebook, facbook, fb, facebook ads, meta, meta ads, instagram, ig, ...
- **Referral** — aliases: referral, referal, referred, reference, word of mouth, wom, indicação, ...

Each entry also has `fuzzyRoots` — prefixes that trigger a match even with heavy typos.

Detection passes, in order:
1. Exact alias match (word-boundary for single words)
2. Substring match for phrases
3. Levenshtein ≤2 for 6+ char aliases, ≤1 for shorter
4. Fuzzy root prefix match

See `backend/src/services/lead-parser.ts` for the full 200-line implementation.

### 5.4 Command system

Interface:

```typescript
interface Command {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  execute(ctx: CommandContext): Promise<CommandResult>;
}

interface CommandContext {
  args: string[];
  rawInput: string;
  command: string;
  prisma: PrismaClient;
  evolution: EvolutionClient;
  scheduler: Scheduler;
  selfJid: string;
  selfPhone: string;
  config: AppConfig;
  logger: Logger;
  now: Date;
  getCommands: () => Command[];
}

interface CommandResult {
  success: boolean;
  reply: string;
  error?: string;
}
```

Registry pattern:

```typescript
class CommandRegistry {
  private commands = new Map<string, Command>();
  constructor(cmds: Command[]) { for (const c of cmds) this.register(c); }
  register(cmd: Command) {
    this.commands.set(cmd.name.toLowerCase(), cmd);
    for (const a of cmd.aliases ?? []) this.commands.set(a.toLowerCase(), cmd);
  }
  resolve(name: string): Command | null { return this.commands.get(name.toLowerCase()) ?? null; }
  parseCommandLine(input: string): { command: Command; rawInput: string; args: string[] } | null {
    // Smart parsing: tries space-separated first, then longest-prefix match
    // for "/status04/09" (no space) inputs
  }
  all(): Command[] { return [...new Set(this.commands.values())]; }
}
```

Dispatcher:

```typescript
class CommandDispatcher {
  async dispatch(message: IngestedMessage): Promise<void> {
    const content = message.content.trim();
    if (!content.startsWith("/")) return;
    const parsed = this.registry.parseCommandLine(content.slice(1));
    if (!parsed) { /* log NOT_FOUND, reply "unknown command" */ return; }
    const { command: cmd, rawInput, args } = parsed;

    // Create CommandLog row
    const logRow = await this.prisma.commandLog.create({ ... });

    const ctx: CommandContext = { args, rawInput, command: cmd.name, ... };
    try {
      const result = await cmd.execute(ctx);
      await this.evolution.sendText(this.selfPhone, result.reply);
      await this.prisma.commandLog.update({ where: { id: logRow.id }, data: { ... } });
    } catch (err) {
      // Reply with error to self-chat, update log
    }
  }

  async runInline(input: string): Promise<{ success; reply; error? }> {
    // Same as dispatch but doesn't send via Evolution — returns the result for
    // the dashboard's test runner.
  }
}
```

### 5.5 Schedulers — two independent systems

**Scheduler** (for `Reminder`) — simple:
- Loads all PENDING reminders on boot
- For each: if `scheduledAt` is in the past, fire immediately with `[Missed]` prefix
- Otherwise: `setTimeout(fire, delay)` if delay < 24.8 days, else defer to daily sweep
- On fire: `evolution.sendText(selfPhone, message)`, update status to SENT/MISSED/FAILED
- Runs `setTimeout`, not cron — these are one-shot only

**ScheduledTaskRunner** (for `ScheduledTask`) — more complex:
- On boot: load all enabled tasks
- For each:
  - If cron task AND `nextFireAt` was > 2 min in the past → fire now with `[missed run]` (recovery)
  - Register the task:
    - Cron → `node-cron.schedule(expr, fireTask)`, store in `cronJobs` map
    - fireAt → `setTimeout(fireTask, delay)` if within MAX_TIMEOUT, else defer
- On fire: look up action in ActionRegistry, zod-validate payload, `Promise.race` execute with 60s timeout
- Update `lastFiredAt`, `runCount`, `failureCount`, `lastResult`, `lastError`
- After success: `failureCount = 0`, update `nextFireAt` via `cron-parser`
- After 10 consecutive failures on a cron task: auto-disable + notify user via self-chat
- One-shot tasks: auto-disable after firing once
- Hourly sweep: re-check for deferred one-shots now within MAX_TIMEOUT window

### 5.6 IncrementalSync (the safety net)

Runs every 5 minutes (via node-cron). Calls `ingest.ingestRaw()` for any message in the first ~10 pages of `/chat/findMessages` that we don't already have.

```typescript
class IncrementalSync {
  async runSafely(trigger: "boot" | "cron") {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.syncRecent();
      this.logger.info(result, "Sync cycle complete");
    } finally {
      this.running = false;
    }
  }

  private async syncRecent(maxPages = 10) {
    const chatNameMap = new Map();  // rebuild every cycle
    const lidToPhone = new Map();
    const phoneToName = new Map();

    // Build resolver maps
    const groups = await this.evolution.fetchAllGroups(true);
    for (const g of groups) {
      chatNameMap.set(g.id, g.subject);
      for (const p of g.participants ?? []) {
        if (p.id && p.phoneNumber) lidToPhone.set(p.id, p.phoneNumber);
      }
    }
    const contacts = await this.evolution.fetchAllContacts();
    for (const c of contacts) {
      if (c.pushName && !/^\d+$/.test(c.pushName)) phoneToName.set(c.remoteJid, c.pushName);
    }

    // Walk pages until we stop finding new messages
    for (let page = 1; page <= maxPages; page++) {
      const { records, pages } = await this.evolution.fetchMessagesPage(page, 100);
      if (!records?.length) break;

      let savedThisPage = 0;
      for (const record of records) {
        const res = await this.ingest.ingestRaw(record, { chatNameMap, lidToPhone, phoneToName });
        if (res.saved) savedThisPage++;
      }

      // Short-circuit: if a whole page had zero new messages, we're caught up
      if (savedThisPage === 0 && page >= 2) break;
      if (page >= pages) break;
    }
  }
}
```

## 6. REST API endpoints

Full list (grouped by route file):

### routes/auth.ts (public + authed)
- `POST /api/auth/login` — body `{username, password}`, returns `{ok, user}` + sets cookie. Rate-limited 5/15min.
- `POST /api/auth/logout` — clears cookie
- `GET /api/auth/me` — returns `{user}` if authed, else 401

### routes/webhook.ts (public, used by Evolution)
- `POST /webhook` — Evolution webhook receiver, always returns 200

### routes/instance.ts (authed)
- `GET /api/instance/status` — connection state, selfJid, selfPhone
- `POST /api/instance/connect` — generate QR code
- `POST /api/instance/disconnect` — logout
- `POST /api/instance/backfill` — walk all Evolution pages, ingest everything
- `POST /api/instance/import-names` — import LID→name mapping from another instance. Body `{sourceInstance, maxPages?}`
- `POST /api/instance/name-mapping` — manual mapping. Body `{mapping: {phone: name}}`
- `GET /api/instance/unresolved-senders` — list phones in a group without human names
- `POST /api/instance/refresh-identity` — re-detect selfJid from Evolution
- `GET /api/instance/audit-leads` — debug endpoint, returns parse result per message

### routes/messages.ts (authed)
- `GET /api/messages` — paginated, filters: search, chatName, chatId, isGroup, from, to, limit, cursor
- `GET /api/messages/chats` — distinct chats with message counts

### routes/commands.ts (authed)
- `GET /api/commands/registry` — list all registered commands
- `GET /api/commands/logs` — paginated command history
- `POST /api/commands/run` — inline run (test runner). Body `{input}`

### routes/reminders.ts (authed)
- `GET /api/reminders?status=PENDING` — list
- `DELETE /api/reminders/:id` — cancel

### routes/schedules.ts (authed)
- `GET /api/schedules` — list
- `GET /api/schedules/actions` — list available action types for the form dropdown
- `POST /api/schedules` — create
- `PATCH /api/schedules/:id` — update
- `POST /api/schedules/:id/toggle` — enable/disable
- `POST /api/schedules/:id/run` — run now (manual trigger)
- `DELETE /api/schedules/:id` — delete

### public
- `GET /health` — deep healthcheck, returns 503 if DB or Evolution unhealthy

## 7. Authentication

Single admin user. Password hashed with bcrypt. JWT cookie:

```typescript
// Login: bcrypt.compare, sign JWT with sub=username, set HttpOnly cookie 7 days
// Middleware: parse cookie, verify JWT, attach req.authUser = {sub}
// requireAuth(req): throw 401 if no authUser
```

Rate limiting: in-memory Map-based sliding window. 5 failed attempts per IP per 15 minutes.

## 8. Frontend (web SPA)

Standard Vite + React + TypeScript. 6 pages:

1. `/login` — username/password form
2. `/` (Dashboard) — connection status, QR code display, recent commands, summary counts
3. `/messages` — paginated table, filters
4. `/commands` — test runner input, registry list, execution history
5. `/reminders` — tabs (PENDING, SENT, MISSED, CANCELLED, FAILED), cancel button
6. `/schedules` — tasks table, create form with dynamic payload template per action type

Data fetching: TanStack Query hooks wrap the API.

Styling: Tailwind with ~10 custom utility classes (`card`, `btn-primary`, `table`, `badge`, etc.) defined in `index.css`.

Routing: `react-router-dom` v6 with a top-level auth guard (redirect to /login if not authed).

## 9. Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the complete first-time setup checklist. Summary:

1. Provision a VPS with Docker + EasyPanel
2. DNS: `zaphelper.yourdomain.com` → VPS IP
3. Create 3 EasyPanel services: postgres, backend, web
4. Push code to a private GitHub repo
5. Connect EasyPanel to the GitHub repo (either via its GitHub App or by making the repo temporarily public during first pull)
6. Set env vars on the backend service (every value from `.env.example`)
7. Deploy backend → web → verify `/health`
8. Log in, scan WhatsApp QR, run a backfill
9. Test `/statustoday` in WhatsApp self-chat

## 10. What this guide omitted (but the code has)

Not every detail is in this document. If you need more, read:

- [ARCHITECTURE.md](./ARCHITECTURE.md) — diagrams, dataflow, invariants
- [DATA-MODEL.md](./DATA-MODEL.md) — each model explained with rationale
- [COMMANDS.md](./COMMANDS.md) — every /command with examples
- [ACTIONS.md](./ACTIONS.md) — pluggable scheduled task actions
- [EVOLUTION-INTEGRATION.md](./EVOLUTION-INTEGRATION.md) — Evolution API quirks, LID issue, workarounds
- [DEPLOYMENT.md](./DEPLOYMENT.md) — end-to-end deploy
- [RUNBOOK.md](./RUNBOOK.md) — problems and fixes
- [DEVELOPMENT.md](./DEVELOPMENT.md) — local dev
- [AUDIT.md](./AUDIT.md) — known risks

If a concept is mentioned but not explained, follow the link to its dedicated doc.

## 11. Testing the rebuild

You've successfully rebuilt zaphelper if:

- [ ] The dashboard loads at `https://your-domain.com` and you can log in
- [ ] `curl https://your-domain.com/health` returns `{ok: true, checks: {db: {ok}, evolution: {ok}, ...}}`
- [ ] Scanning the QR connects WhatsApp and self-identity is detected
- [ ] A manual backfill pulls historical messages from Evolution
- [ ] Running `/statustoday` (via dashboard test runner OR WhatsApp self-chat) returns a summary
- [ ] Creating a scheduled task and clicking "Run" fires the action successfully
- [ ] `/audit` shows the parser's skipped-message reasoning
- [ ] Dashboard shows Connect/Disconnect working
- [ ] Rate limit kicks in after 5 failed login attempts

If all checks pass, you have a working zaphelper equivalent. Port to any stack that can do the same — Python + FastAPI + Celery, Go + Chi + cron, etc. The architecture is language-agnostic.

## 12. Porting notes (if rebuilding in a different stack)

### Python/FastAPI equivalent

- Prisma → SQLAlchemy 2.0 + Alembic
- Fastify → FastAPI
- node-cron → APScheduler
- zod → Pydantic v2
- pino → structlog
- Vite/React → still use Vite/React for the web (or swap to HTMX)

Biggest difference: Node's `setTimeout` has the 24.8-day quirk; Python doesn't. Simplifies the scheduler.

### Go equivalent

- Prisma → ent or sqlc + goose
- Fastify → chi or echo
- node-cron → `github.com/robfig/cron/v3`
- zod → use struct tags + validator
- pino → zerolog or slog
- React → same

Go makes the concurrent model explicit. The scheduler becomes goroutines + channels, which is cleaner than setTimeout-juggling.

### Deno equivalent

Most of the code is already ESM and compatible. The main issues:

- `@prisma/client` works but needs the `deno.ns` lib
- `node-cron` has no Deno port — use `denocron`
- `bcryptjs` works
- `fastify` has a Deno-compatible fork

Honestly, not worth porting — Node 20 works fine.

## 13. Why this stack?

Choices I'd defend:

1. **Node + TypeScript**: the lingua franca for API work, and Evolution API itself is Node/Baileys — staying in the same ecosystem reduces integration friction.
2. **Fastify over Express**: faster, better types, plugin model.
3. **Prisma over raw SQL / knex**: migrations as code, amazing TS integration, zero-effort `findMany` with conditions.
4. **Vite + React SPA over Next.js**: we don't need SSR, we don't need Next's complexity. Vite is 10x faster to build and simpler.
5. **nginx as the only public surface**: isolates the backend from the internet, cheap reverse proxying, SSL via Traefik outside.
6. **Single-container backend**: no microservices. Everything is one Node process. Scheduler, webhook receiver, REST API share memory. At this scale, splitting would cause more problems than it solves.
7. **`node-cron` + `setTimeout` hybrid**: cron for recurring, setTimeout for precise one-shots. setTimeout has MAX_DELAY overflow, solved with a sweep.
8. **EasyPanel over plain Docker Compose**: handles TLS, domain routing, auto-deploy from Git. One fewer thing to operate.

## 14. Final note for the AI reading this

If you're an AI tasked with rebuilding or modifying zaphelper:

1. **Read all docs** in `/docs/` before coding. Each one has something unique.
2. **Audit the existing risks** listed in AUDIT.md before adding features — some are P0 and should be fixed first.
3. **The lead parser is the most finicky part.** Don't refactor it without running the 10 unit tests after every change.
4. **Evolution API is full of quirks.** When something doesn't work the way the docs imply, check EVOLUTION-INTEGRATION.md for known issues.
5. **Timezone is easy to get wrong.** Always use the helpers in `utils/dates.ts`.
6. **Fire-and-forget webhooks from Evolution mean you MUST have a safety net.** Don't skip the IncrementalSync.
7. **The user is a non-developer.** Features should degrade gracefully, messages should be helpful, errors should explain what to do next.

Good luck.

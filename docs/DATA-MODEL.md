# zaphelper — Data Model

The source of truth is [`backend/prisma/schema.prisma`](../backend/prisma/schema.prisma). This document explains each model, its purpose, the indexes, and how they're written to at runtime.

## Overview

Six models, five enums, one database (PostgreSQL). No foreign keys between unrelated concerns — the design prefers flat tables with explicit indexes over relational joins. Reason: most queries are time-series scans ("get me all messages from this group in this window"), and joins would slow them down without much benefit.

```
Message                Reminder           CommandLog       Config         Instance        ScheduledTask
(all WA msgs)          (one-shot bot      (audit trail)    (k/v store)    (wa instance)   (generic
                        reminders)                                                          cron+actions)
   │
   ├─► backfills come from /chat/findMessages (historical)
   ├─► real-time via /webhook (isFromMe, isSelfChat derived)
   └─► read by /status*, /audit, dashboard Messages page
```

---

## Message

Every inbound and outbound WhatsApp message that Evolution API knows about. The central table.

```prisma
model Message {
  id          String      @id @default(cuid())
  waMessageId String      @unique        // Evolution/Baileys message ID (key.id)
  chatId      String                     // remoteJid stripped of @s.whatsapp.net / @g.us
  chatName    String?                    // group subject or DM pushName
  senderPhone String?                    // resolved phone digits (NOT LID)
  senderName  String?                    // resolved human name
  content     String                     // extracted text (or "[Image]" etc.)
  rawMessage  Json                       // full Baileys payload, for debugging / re-parsing
  messageType MessageType                // TEXT | IMAGE | AUDIO | VIDEO | DOCUMENT | STICKER | CONTACT | LOCATION | OTHER
  isGroup     Boolean     @default(false)
  isFromMe    Boolean     @default(false)
  isSelfChat  Boolean     @default(false)  // computed: fromMe && remoteJid === selfJid
  timestamp   DateTime                   // messageTimestamp * 1000
  createdAt   DateTime    @default(now())

  @@index([chatId, timestamp])                   // /status* queries
  @@index([isSelfChat, isFromMe, timestamp])     // command history lookups
  @@index([chatName])                            // fuzzy group name search
  @@index([timestamp])                           // general time-series
}
```

### Column notes

- **`waMessageId`**: the value of `data.key.id` from Evolution webhooks. Unique across all messages we'll ever receive. Used as the dedupe key — re-ingesting the same message (e.g. webhook retry + incremental sync) is a no-op thanks to the UNIQUE index.
- **`chatId`**: the group or DM identifier without the WhatsApp suffix. For a group it's `"120363396996770368"`; for a DM it's the phone digits of the other party. We strip the suffix so you can grep by the chatId across groups and DMs uniformly.
- **`chatName`**: populated at ingest time. For groups, resolved via `fetchAllGroups()` subject. For DMs, taken from the message's own `pushName`. Mutable later if the group is renamed (the next backfill/sync will overwrite).
- **`senderPhone`**: **always** the real phone number in digits form, even for group messages. The LID → phone resolution happens during ingest (via the `lidToPhone` map built from group participants). If we couldn't resolve (e.g. a participant we don't know yet), this falls back to the raw LID digits.
- **`senderName`**: the human-readable name we know for this phone. Resolution priority: (1) manual mapping from `Config` table (`name:<phone>`) — highest priority, survives everything; (2) `phoneToName` map from Evolution's contacts; (3) message's `pushName` if it's not just digits; (4) `null` as last resort.
- **`rawMessage`**: Full JSON blob of the Baileys record. Kept so we can re-parse it later without re-querying Evolution. A few MB per row at scale, but we have ~11k messages → tens of MB total.
- **`messageType`**: coarse category. We don't distinguish sub-types (e.g. GIF vs regular image) because the lead parser only cares about TEXT.
- **`isFromMe`**: `key.fromMe` from Evolution. True for messages Filipe sent; false for messages Filipe received.
- **`isSelfChat`**: computed at ingest time. True iff `isFromMe && remoteJid === selfJid`. Set in `MessageIngest.ingest()` using the current `SelfIdentity.getJid()`. **Important**: this is frozen at ingest time. If the user ever changed phones, old messages keep their original classification.
- **`timestamp`**: UTC. Baileys gives us `messageTimestamp` in seconds; we multiply by 1000. All time-window queries use this field.

### Index rationale

- `[chatId, timestamp]` — the hot path for `/statustoday` and friends: "give me all messages from this specific group between X and Y".
- `[isSelfChat, isFromMe, timestamp]` — dashboard's "recent commands" lookup.
- `[chatName]` — used by the `contains + insensitive` fuzzy match in the status commands (`chatName contains "Be Home Leads Scheduled"`).
- `[timestamp]` — general scans like "what's the most recent message in the DB?" during sync short-circuit checks.

### Write paths

1. `routes/webhook.ts` → `MessageIngest.ingest()` (real-time)
2. `routes/instance.ts#/api/instance/backfill` → `MessageIngest.ingestRaw()` (full walk)
3. `services/incremental-sync.ts` → `MessageIngest.ingestRaw()` (every 5 min)
4. Manual retrofit in `/api/instance/import-names` and the name-mapping endpoint can update `senderName`/`senderPhone` on existing rows

### Read paths

1. `status-shared.ts#buildStatusReply()` — queries by `chatName + timestamp`, parses each
2. `audit.command.ts` — same query, filters for skipped
3. `routes/messages.ts` — general browser view
4. `routes/instance.ts#audit-leads` — debug endpoint

---

## Reminder

Simple one-shot reminders created via `/reminder YYYY-MM-DD HH:MM message`.

```prisma
model Reminder {
  id           String         @id @default(cuid())
  scheduledAt  DateTime                       // when to fire (UTC, display via TZ)
  message      String                         // body to send to self
  status       ReminderStatus @default(PENDING)
  createdByCmd String?                        // optional link to CommandLog
  createdAt    DateTime       @default(now())
  sentAt       DateTime?
  error        String?

  @@index([status, scheduledAt])
}

enum ReminderStatus { PENDING SENT MISSED CANCELLED FAILED }
```

### Semantics

- `PENDING`: not yet fired. Loaded on boot by `Scheduler.start()`.
- `SENT`: successfully delivered via Evolution.
- `MISSED`: `scheduledAt` was in the past when the `Scheduler` loaded it (container was down across the fire time). Fired anyway, with a `⏰ [Missed reminder]` prefix.
- `CANCELLED`: user deleted via `/reminders` UI or `/api/reminders/:id` DELETE.
- `FAILED`: Evolution returned an error; the `error` column has the message.

### Lifecycle

1. Created by `/reminder` command → `Scheduler.schedule(reminder)` → `setTimeout` for the delay
2. Fire time reached → `Scheduler.fire()` → Evolution sendText → update status
3. Container restart → `Scheduler.start()` re-loads all PENDING, schedules future ones, fires past-due as MISSED

### Why a dedicated table and not a `ScheduledTask`?

Reminders predate the generic `ScheduledTask` system and have simpler semantics (one message, one target, always self, one-shot). They also don't need to survive the "auto-disable after 10 failures" logic. We could collapse them into ScheduledTasks with a `sendText` action and a `fireAt`, but the current split is simpler to reason about and the bar for migrating is "does it actually cause pain?" — currently no.

---

## CommandLog

Audit trail of every slash command execution (both via webhook and inline runner).

```prisma
model CommandLog {
  id         String        @id @default(cuid())
  command    String                           // "statustoday"
  args       String?                          // "2026-04-10 14:00 call"
  rawInput   String                           // the full message starting with "/"
  messageId  String?                          // FK to Message.id (null for inline runs)
  message    Message?      @relation(fields: [messageId], references: [id], onDelete: SetNull)
  output     String?                          // reply text
  status     CommandStatus                    // SUCCESS | FAILURE | NOT_FOUND
  error      String?
  executedAt DateTime      @default(now())
  durationMs Int?

  @@index([executedAt])
  @@index([command, executedAt])
}
```

### How it's used

- Dashboard Commands page shows the last N logs
- `audit.command.ts` can join to see what the parser thought of historical messages
- No retention policy yet — grows unbounded. At current volume (~10 commands/day), not an issue.

---

## Config

Key-value store for runtime configuration that doesn't fit anywhere else.

```prisma
model Config {
  key       String   @id          // e.g. "self_jid", "name:12543343617"
  value     String
  updatedAt DateTime @updatedAt
}
```

### Known keys

- **`self_jid`** — the connected user's full WhatsApp JID (e.g. `16198886149@s.whatsapp.net`). Written by `SelfIdentity` on first connection detection. Read to determine `isSelfChat` on every incoming message.
- **`name:<phone>`** — one entry per phone number we want to display with a specific name. Written by `/api/instance/name-mapping` (manual) or `/api/instance/import-names` (bulk import from another Evolution instance). Read by `MessageIngest` into an in-memory cache.

### Why key-value and not columns?

Two reasons:

1. These don't share any structure with each other
2. It keeps the schema stable — adding a new "config value" doesn't need a migration

---

## Instance

Tracks the single WhatsApp instance this deployment manages.

```prisma
model Instance {
  id              String         @id @default(cuid())
  name            String         @unique        // EVOLUTION_INSTANCE_NAME
  phoneNumber     String?                       // digits detected post-connection
  ownerJid        String?                       // e.g. "15551234567@s.whatsapp.net"
  status          InstanceStatus @default(DISCONNECTED)
  lastConnectedAt DateTime?
  lastSeenAt      DateTime?
  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt
}

enum InstanceStatus { DISCONNECTED CONNECTING CONNECTED ERROR }
```

### Populated by

- `routes/webhook.ts` on `CONNECTION_UPDATE` events
- `routes/instance.ts#status` route (keeps it in sync with the live Evolution state)
- `SelfIdentity.init()` reads it for the `ownerJid`

### Why a table if we only ever have one row?

Future-proofing. If we ever manage multiple instances (e.g. personal + business), the schema is ready. Also, the `lastConnectedAt`/`lastSeenAt` fields give us a history of connection state changes.

---

## ScheduledTask

Generic cron/one-shot scheduled task with pluggable actions. The newest model, introduced in migration `add_scheduled_task`.

```prisma
model ScheduledTask {
  id              String   @id @default(cuid())
  name            String                           // display name for the dashboard
  enabled         Boolean  @default(true)

  // Mutually exclusive — exactly one of these two must be set:
  cronExpression  String?                          // "0 9 * * 1" = Mon 9am
  fireAt          DateTime?                        // one-shot absolute time

  actionType      String                           // "sendText" | "runCommand" | "webhook" | "sendVoice"
  actionPayload   Json                             // free-form per action type

  lastFiredAt     DateTime?
  nextFireAt      DateTime?
  lastError       String?
  lastResult      String?                          // last action output (truncated to 500)
  runCount        Int      @default(0)
  failureCount    Int      @default(0)             // consecutive failures; reset on success

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([enabled, nextFireAt])
  @@index([enabled, fireAt])
}
```

### Invariants

- **XOR**: exactly one of `cronExpression` or `fireAt` must be set. The service layer (`ScheduledTaskService.validateScheduling()`) enforces this.
- **`failureCount` resets on success** — not a total failure counter, but a consecutive-failures counter. Used to auto-disable after 10 in a row.
- **`nextFireAt`** is best-effort metadata, computed by `cron-parser.parseExpression().next()` after every fire. It's used only for:
  1. Dashboard display
  2. Boot recovery — if `nextFireAt` was in the past on startup, fire the task with a `[missed]` flag

### Action payloads

Each action type has its own payload shape validated by zod. See [ACTIONS.md](./ACTIONS.md) for the full schemas.

### Lifecycle

1. Created via `POST /api/schedules` or `/schedule daily|weekly|once` command → `ScheduledTaskService.create()` validates, inserts, then `taskRunner.register(task)`
2. `register()`:
   - cron: `node-cron.schedule(expr, fireTask)`, stored in `cronJobs` map
   - fireAt: `setTimeout(fireTask, delay)` if delay ≤ 24.8 days; deferred to hourly sweep otherwise
3. Fire: `fireTask()` validates, runs action with 60s timeout, updates `lastFiredAt` etc., auto-disables on repeated failure
4. Stop: either user deletes (`ScheduledTaskService.delete`) or toggles (`setEnabled(false)`)

---

## Enums

```prisma
enum MessageType     { TEXT IMAGE AUDIO VIDEO DOCUMENT STICKER CONTACT LOCATION OTHER }
enum ReminderStatus  { PENDING SENT MISSED CANCELLED FAILED }
enum CommandStatus   { SUCCESS FAILURE NOT_FOUND }
enum InstanceStatus  { DISCONNECTED CONNECTING CONNECTED ERROR }
```

(ScheduledTask uses a free-form `actionType` string, not an enum, because the set is open — plugins can add new types.)

---

## Migrations history

```
prisma/migrations/
├── 20260411004625_init/
│   └── migration.sql   — creates all tables except ScheduledTask
└── 20260411055158_add_scheduled_task/
    └── migration.sql   — adds ScheduledTask table
```

Never edit a past migration; always create a new one via `prisma migrate dev`. On prod, `prisma migrate deploy` runs on container startup (from the backend Dockerfile's CMD).

## Foreign keys

The only one: `CommandLog.messageId → Message.id` with `onDelete: SetNull`. If we ever clean up old messages, command log entries keep their command name/args but lose the link to the originating message, which is fine for audit purposes.

Everything else is "soft linking" via shared keys (e.g. `Config.key = "name:12543343617"` is semantically linked to `Message.senderPhone = "12543343617"` but there's no FK).

## Row-count budgets

At current load (2026-04-11):

| Model | Count | Growth rate |
|---|---|---|
| Message | ~11,400 | ~200/day |
| CommandLog | ~100 | ~10-30/day |
| Reminder | 0 | a few/week |
| ScheduledTask | 0 | <10 total expected |
| Config | ~150 (142 names + self_jid) | stable |
| Instance | 1 | never changes |

Projection: the `Message` table hits 100k rows in ~1.5 years. Postgres handles that easily; no need for archiving strategy for the next ~3 years.

## Why no separate `Contact` table?

I considered it but decided against. Reasons:

1. Names change rarely → the Config-table approach works
2. Historical messages keep their point-in-time names, which is often what you want
3. A proper Contact table would need sync logic (when does a name change propagate to existing messages?)
4. The fuzzy matching in `detectSource` means we don't need to normalize on write

If the app ever grows into a CRM, a first-class Contact table makes sense. For the current scope, `Config` is simpler.

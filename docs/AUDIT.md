# zaphelper — Security & Reliability Audit

**Audit date:** 2026-04-11
**Auditor:** Claude (sistemático, não-exaustivo)
**Scope:** Entire zaphelper system — backend (Fastify), frontend (Vite/React), database (PostgreSQL), integrations (Evolution API), deployment (EasyPanel)

This document maps every reliability, security, and correctness risk I found, with priority and concrete mitigation.

Priorities:

- **P0** — could cause data loss, downtime, security breach, or user-visible incorrect data. Must fix.
- **P1** — quality of life, resilience, or maintainability. Should fix in the next days.
- **P2** — nice to have, longer-term improvements.

---

## Table of contents

1. [Data reliability](#data-reliability)
2. [Security](#security)
3. [Availability](#availability)
4. [Performance](#performance)
5. [Observability](#observability)
6. [Maintainability](#maintainability)
7. [External integrations](#external-integrations)
8. [Domain correctness (lead parser, scheduler)](#domain-correctness)
9. [Priority summary](#priority-summary)

---

## Data reliability

### ✅ FIXED — Webhook drop during restart

**Problem:** Evolution API fires webhooks fire-and-forget, with no retry on backend downtime. Any WhatsApp message arriving during a container restart (deploy, crash, manual reboot) was **silently lost**. This was discovered today when 13 real leads posted between 09:20 and 12:53 never made it into the database until a manual backfill was triggered.

**Root cause:** Evolution's webhook implementation does not queue+retry on HTTP 5xx / connection-refused errors — it just logs and moves on.

**Mitigation (implemented):** `IncrementalSync` service runs every 5 minutes, pulls anything newer than our latest stored message from Evolution's own database via `/chat/findMessages`. Idempotent via `waMessageId` unique constraint. Short-circuits as soon as a page has zero new rows so steady-state cost is one API call every 5 minutes.

**Residual risk:** Worst case latency between message arrival and our DB is 5 minutes when the webhook is broken. In normal operation (webhook delivering), it's ~1 second.

---

### 🔴 P0 — No backups of our PostgreSQL

**Problem:** The zaphelper Postgres instance on EasyPanel has **no automated backups configured**. If the database volume gets corrupted, deleted, or the EasyPanel node dies, we lose:

- 11,356+ historical WhatsApp messages
- All scheduled tasks
- All pending reminders
- All config (including the self-identity JID mapping)
- The manual LID → name mappings

We could partially re-ingest from Evolution API, **but Evolution's DB is also non-backed-up and could disappear at the same time** (same VPS). The LID → pushName resolution we did via `markar-a3525386` worked only because that instance happened to still exist; it's already disconnected and could be deleted any time.

**Impact:** Total data loss. Recovery would mean starting over.

**Mitigation:**

1. Enable EasyPanel's built-in postgres backup (if available in your plan) — Services → zaphelper-postgres → Backup tab
2. OR add a daily `pg_dump` cron that uploads to an external bucket (Backblaze B2 is $6/TB/mo, S3 cheaper for small sizes)
3. Test a restore once per quarter

**Recommended:** a scheduled task in zaphelper itself that does `pg_dump | gzip | upload to B2` every day at 3 AM. Can be implemented with a new `backup` action type.

---

### 🟡 P1 — `markar-a3525386` as the single source of truth for historical names

**Problem:** Today we imported 142 human names (Laura, Linda, Yaniliz, etc.) from the `markar-a3525386` Evolution instance because the WhatsApp LID privacy system meant Evolution's `zaphelper-main` never received the notifyNames for messages older than "right now". The import wrote these names to the `Config` table as a persistent map.

But `markar-a3525386` is currently in `disconnectionStatus: close` and **could be garbage-collected** from the Evolution API at any time. If someone deletes it, we lose the canonical source of those names.

**Impact:** If the Config entries are ever lost (DB restore from earlier snapshot, manual cleanup, bug in a migration), we cannot re-resolve them without that instance.

**Mitigation:**

1. Dump the current Config table entries for `name:*` keys to a JSON file committed to the repo as a fallback seed (e.g. `backend/prisma/seed-names.json`)
2. On boot, the backend reads the seed and upserts any missing entries into Config
3. Add an admin endpoint to export the current mapping as JSON so it can be re-committed when new names are added

---

### 🟡 P1 — LID → name resolution doesn't update for new participants

**Problem:** If a new person joins the "Be Home Leads Scheduled" group tomorrow, their `@lid` will not be in our `Config` table, so `/statustoday` will show their LID digits instead of their name. The user would need to manually add the mapping via the `/api/instance/name-mapping` endpoint.

**Impact:** Low urgency today, but any group membership change triggers this issue.

**Mitigation:**

1. `IncrementalSync` could query `/group/participants` periodically and auto-add new participants to `lidToPhone` + try `fetchProfile` for any missing names
2. Show unresolved senders in the dashboard with a "set name" button
3. Already have the endpoint `GET /api/instance/unresolved-senders` — just needs a UI

---

### 🟡 P1 — pushName drift (contact renames themselves)

**Problem:** If Laura changes her WhatsApp profile name to "Laura Garcia", our DB still says "Laura". We never overwrite once resolved.

**Impact:** Minor — old messages keep the name at the time they were posted, new messages also keep the old name because the Config map is static.

**Mitigation:** Store pushName per-message (already done via `senderName`) and let the dashboard query distinct recent senderNames per phone. Or periodically refresh Config from new messages' pushName when they don't match.

---

### 🔴 P0 — Reminder / scheduled task fires during restart are dropped

**Problem:** Same root cause as the webhook issue. If a reminder or scheduled cron fires at 18:00 but the container is restarting at 18:00:05, the reminder is **never sent**. The Scheduler's "boot recovery" catches reminders whose `scheduledAt` was in the past, but **cron-based ScheduledTasks are not recovered** — node-cron only fires on exact matches going forward.

**Impact:** A reminder the user set for 9am doesn't fire if we happen to deploy at 8:59. They'd never know.

**Mitigation:**

1. On ScheduledTaskRunner startup, look for cron tasks whose `nextFireAt` is in the past (we already write this on each fire) and fire them immediately with a `[missed]` prefix
2. Write `nextFireAt` accurately using a proper cron parser (`cron-parser` package) — currently we approximate with "+1 hour" which is useless
3. For `/reminder`: already recovers past-due reminders on boot, that path is OK
4. For scheduled tasks: add recovery logic to `ScheduledTaskRunner.start()`

---

### 🟡 P1 — Prisma migrations are non-reversible in prod

**Problem:** `prisma migrate deploy` only applies new migrations. If we ship a bad migration (e.g. drop a column by accident), we have **no rollback** — the container crash-loops on startup and we have to manually write a new migration to undo.

**Impact:** A deployment outage during a botched migration. Hasn't happened yet.

**Mitigation:**

1. Always review migrations manually before pushing
2. Test migrations against a staging DB (doesn't exist yet — see below)
3. Keep a snapshot of Postgres before running migrations in prod (manual for now)
4. Consider `prisma migrate diff` to preview SQL before applying

---

## Security

### 🔴 P0 — No rate limit on login

**Problem:** `POST /api/auth/login` has zero rate limiting. An attacker with the URL can brute-force the admin password at thousands of requests per second. Bcrypt slows them to ~100/sec, but `admin` + common passwords could still be found in minutes.

**Impact:** Full panel compromise → can read all messages, create scheduled tasks, trigger webhooks, connect to Evolution.

**Mitigation:** In-memory rate limiter: max 5 failed attempts per IP per 15 minutes, locks out for 1 hour after that. Simple Map-based implementation, no Redis needed. **Implementing now (see below).**

---

### 🔴 P0 — No XSS sanitization on dashboard

**Problem:** The Messages dashboard page renders message content with `{m.content}` inside a `<div>`. React's JSX auto-escapes text children by default, so a literal `<script>` becomes text and doesn't execute. **But**: if we ever add `dangerouslySetInnerHTML` or use a markdown renderer, we're exposed. Right now the Commands page shows `{log.output}` and `{log.error}` the same way.

**Current state:** Safe (React auto-escapes). **Risk:** One line away from a vuln any future refactor could introduce.

**Mitigation:**

1. Add a lint rule forbidding `dangerouslySetInnerHTML` without a code review comment
2. If we ever render markdown (e.g. bold sender names), use a sanitizing renderer like `react-markdown` with `skipHtml`
3. Add CSP headers in nginx (`Content-Security-Policy: default-src 'self'; script-src 'self'`)

---

### 🟡 P1 — JWT has no revocation

**Problem:** When you change the admin password, old JWT cookies are still valid until their 7-day expiration. If a cookie leaks, you can't invalidate it.

**Impact:** Low (single admin user), but bad practice.

**Mitigation:**

1. Store a `tokenVersion` in the Config table; bump it on password change
2. Include tokenVersion in the JWT payload; reject mismatched tokens
3. Or: shorten JWT lifetime to 1 hour + refresh token pattern (heavier, probably overkill)

---

### 🟡 P1 — Evolution API key is god mode across all instances

**Problem:** The `EVOLUTION_API_KEY` you gave me has full access to **every instance** on evolution.maverstudio.com: leadquest-pro, markar-*, zaphelper-*, filipe-*. If this key leaks (or I'm compromised, or the env file is dumped), an attacker can read every WhatsApp message of every connected instance.

**Impact:** Catastrophic — affects Markar, zaphelper, and any other business using that Evolution deployment.

**Mitigation:**

1. **Ideal but expensive:** run a separate Evolution API instance just for zaphelper with its own key
2. **Practical:** rotate the global API key whenever a .env file or deploy config gets shared/logged/committed. **Mine the recent logs for leaked keys.**
3. **Better than nothing:** Evolution API supports per-instance tokens (the `instance.token` field we've seen in responses). Check if the admin key can be scoped.

---

### 🟡 P1 — Secrets in CI/deploy environment, never rotated

**Problem:** The current secrets (`JWT_SECRET`, `ADMIN_PASSWORD_HASH`, `EVOLUTION_API_KEY`, Postgres password) are stored in the EasyPanel environment variables and have never been rotated. Anyone with EasyPanel access (including me via the API token) can read them.

**Impact:** No immediate issue but poor hygiene.

**Mitigation:**

1. Document a quarterly rotation schedule
2. Generate a checklist of values to rotate
3. Have a `scripts/rotate-secrets.sh` that prints new values and the exact EasyPanel API calls to set them (so rotation is a 1-command operation)

---

### 🟢 P2 — No audit log of admin actions

**Problem:** The dashboard only has one user, but every create/delete/backfill is done by "admin". No record of **when** any action was taken or from **which IP**.

**Impact:** If something weird happens, no forensic trail.

**Mitigation:** Add an `AdminAuditLog` table with (action, targetId, payload, ip, ts). Write from middleware on every non-GET request. Expose in the dashboard.

---

## Availability

### 🟡 P1 — Single point of failure

**Problem:** 1 Hostinger VPS + 1 EasyPanel + 1 Postgres + 1 Evolution instance + 1 zaphelper container. Any of them going down takes the system offline. No failover.

**Impact:** If Hostinger has an outage or the VPS disk fails, everything is offline until it recovers.

**Mitigation (none urgent):**

- **Short term:** rely on Hostinger's SLA (~99.9%), plus the Incremental Sync safety net to catch up when we come back
- **Medium term:** offsite daily Postgres backup (see P0 data backup above)
- **Long term:** move to a managed Postgres (Neon, Supabase) — that way losing the VPS doesn't lose data

---

### 🔴 P0 — Deep healthcheck missing

**Problem:** `GET /health` returns `{ok: true}` regardless of whether the DB is reachable, Evolution API is reachable, or the scheduler is alive. EasyPanel can't detect a degraded backend.

**Impact:** When the backend is broken but still serving 200 OK on /health, EasyPanel thinks it's fine and doesn't restart. We've already seen Evolution connectivity issues — this would mask them.

**Mitigation:** `/health` checks Prisma round-trip + Evolution connectionState. If any fails, return 503. EasyPanel will see it and restart. **Implementing now.**

---

### 🟡 P1 — No external uptime monitoring

**Problem:** If `zaphelper.maverstudio.com` goes fully down, nobody knows until you try to use it.

**Mitigation:**

1. Sign up for UptimeRobot (free tier, 5-min check interval) or BetterStack
2. Point at `https://zaphelper.maverstudio.com/health`
3. Alert to WhatsApp via... wait, we ARE the WhatsApp thing. Alert to email.

---

### 🟡 P1 — No graceful shutdown delay

**Problem:** On SIGTERM, we close the Fastify server and disconnect Prisma immediately. Any in-flight webhook is cut short — Evolution gets a connection reset and discards the message.

**Impact:** Every deploy loses the webhooks that arrive during the ~5-30s restart window. **This is the exact problem we saw today.**

**Mitigation:** Shutdown handler:
1. Stop accepting new connections (`app.close()` already does this)
2. Wait up to 10 seconds for in-flight handlers to complete
3. Then disconnect Prisma
4. Process.exit only after all above

---

## Performance

### 🟢 P2 — Every `/status*` re-parses all messages in the window

**Problem:** `/statusweek` loads all messages from the group in the last 7 days, runs `parseLead` on each, aggregates. No caching. For 100 messages it's instant; for 100k it would be slow.

**Current:** Fine at current scale (78 messages per week → < 50ms).

**Mitigation (when needed):**

1. Add a `parsedLead` JSONB column to `Message` — store the result of `parseLead` on write
2. Update it during ingest and backfill
3. Queries then just aggregate instead of re-parsing

---

### 🟢 P2 — Backfill `ingestRaw` creates one row at a time

**Problem:** Full backfill of 11k messages runs 11k `prisma.message.create` calls. Each is a roundtrip to Postgres (~5ms). Total: ~55 seconds. Good enough but could be 5x faster with `createMany({ skipDuplicates: true })`.

**Mitigation:** Batch 100 records per INSERT. Needs Prisma Postgres (supports `skipDuplicates`).

---

### 🟡 P1 — IncrementalSync refetches groups+contacts every cycle

**Problem:** Every 5 minutes, the sync calls `fetchAllGroups(true)` + `fetchAllContacts()`, which is 2 Evolution API calls. Cheap (~200ms) but wasteful — groups rarely change.

**Mitigation:** Cache the maps in memory, refresh every hour or when we notice a new `chatId` we haven't seen.

---

## Observability

### 🔴 P0 (soft) — No way to know when things fail silently

**Problem:** The Incremental Sync runs every 5 min and logs to stdout. If it fails 10 times in a row (Evolution API down, Postgres locked, etc.), nobody notices until someone tries to use the dashboard. Same for scheduled tasks — if they fail, the dashboard shows failureCount++ but no alert.

**Mitigation:**

1. Add a "health" aggregator: count failures in the last hour across sync/reminders/tasks
2. If threshold exceeded, send a WhatsApp message to self-chat: "⚠️ zaphelper degraded: 5 consecutive sync failures"
3. Dashboard banner when ANY task has `failureCount > 5` or `lastError` is recent

---

### 🟡 P1 — Logs are only on the container

**Problem:** `docker logs zaphelper_backend` works but is ephemeral. When the container restarts, logs older than a few minutes are gone. No way to look back at what happened.

**Mitigation:**

1. Ship logs to an external service: Logtail (free tier 1 GB/mo), Axiom (free 500 GB/mo), or Grafana Cloud
2. Pino has HTTP transports built in — 5 lines of config
3. Enables grep across time windows, alerts, dashboards

---

### 🟡 P1 — No metrics / dashboards

**Problem:** Can't answer "how many webhooks did we receive in the last hour?" or "what's the average command execution time?".

**Mitigation:** Prometheus-compatible metrics endpoint via `fastify-metrics`. Scrape from Grafana Cloud free tier.

---

## Maintainability

### 🟡 P1 — Tests: only the lead parser is tested

**Problem:** We have 10 unit tests for `parseLead`. Zero tests for:

- Webhook handler
- MessageIngest (including LID resolution)
- Scheduler / ScheduledTaskRunner
- IncrementalSync
- All 4 actions
- All 13 commands
- All API routes
- Auth flow
- Date range parser

**Impact:** Any refactor risks silent breakage. Today's audit already found that a `runInline` code path diverged from `dispatch` — tests would have caught that.

**Mitigation:**

1. Start with the highest-risk components:
   - MessageIngest (state mutations, duplicate handling, LID resolution)
   - `parseStatusRange` (user-facing, many edge cases)
   - ActionRegistry validation
2. Don't aim for 100% — aim for "if I refactor, tests scream"

---

### 🟡 P1 — No staging environment

**Problem:** Every change goes straight to prod. Test in prod = break in prod.

**Mitigation:**

1. Create a second EasyPanel compose with `zaphelper-staging-*` services (backend + postgres + web)
2. Staging has its own Evolution instance (or reuses zaphelper-dev we already have)
3. Deploy = push to `staging` branch → EasyPanel auto-deploys
4. Smoke test in staging → merge to `main` → auto-deploy prod

Zero cost if the VPS has capacity.

---

### 🟡 P1 — Frontend types are hand-copied from backend

**Problem:** `web/src/api/hooks.ts` has `interface MessageRow { ... }` that duplicates the Prisma Message model. If the backend adds a field, frontend drifts silently.

**Mitigation:**

1. Easiest: put shared types in a `shared/` workspace package
2. Better: generate frontend types from backend OpenAPI spec (or tRPC, but that's a bigger change)
3. For now: document the drift risk and review both sides on schema changes

---

### 🟢 P2 — Rollback is manual and slow

**Problem:** If a deploy breaks, rollback is `git revert HEAD && git push` + wait ~2 min for rebuild. No "instant rollback" to last-known-good image.

**Mitigation:** Tag successful deploys in Docker registry. Rollback = redeploy the tagged image. Requires changing build pipeline.

---

## External integrations

### 🔴 P0 — Evolution API version upgrades can silently break us

**Problem:** We depend on specific Evolution API endpoints:

- `/chat/findMessages/{instance}` with specific request/response shape
- `/group/participants/{instance}` (the newer participantsData schema)
- `/chat/fetchProfile` with `name` in response
- `/chat/findContacts` with `pushName`
- Webhook payload structure

Evolution API is under active development. We saw issues like #2267 (pushName null on @lid) being NOT fixed in 2.3.7. When maverstudio updates Evolution, our code could break silently.

**Mitigation:**

1. Pin the Evolution API version (or at least minor)
2. Document: "before upgrading Evolution, test in staging"
3. Add a smoke test script: `test-evolution-integration.sh` that pokes every endpoint we depend on and verifies expected shape
4. Run it after every Evolution upgrade

---

### 🟡 P1 — WhatsApp multi-device "device removed" kicks the instance

**Problem:** We saw that older instances (`markar-a3525386`, `leadquest-pro`, etc.) are all in `disconnectionStatus: close` with error `device_removed`. That happens when you reach the WhatsApp multi-device limit (4 linked devices) and a new scan kicks an old one.

**Impact:** If you link a 5th device to your WhatsApp, zaphelper-main will be kicked. No leads until you rescan the QR.

**Mitigation:**

1. `IncrementalSync` already detects failures (repeated Evolution errors on connectionState)
2. Add alerting: when connectionState flips to anything except `open`, send a WhatsApp notification to a fallback number or email
3. Document the 4-device limit

---

### 🟢 P2 — Timezone is env-var based

**Problem:** If someone sets `TZ=UTC` without thinking, `/statustoday` breaks subtly (today = UTC day, which is yesterday at 5pm LA time).

**Mitigation:** Add a sanity check on boot: log the current TZ and the current "today" boundary. Show it in the dashboard.

---

## Domain correctness

### 🟡 P1 — Lead parser ignores edited / deleted messages

**Problem:** WhatsApp allows editing and deleting messages. Evolution delivers an `update` event for these. Our ingest only handles `upsert`, so:

- Edited lead: old content stays in our DB, the user sees stale data in `/statustoday`
- Deleted lead: still counted

**Mitigation:**

1. Handle `MESSAGES_UPDATE` webhook event — update content, flag as edited
2. Handle `MESSAGES_DELETE` — flag as deleted, exclude from aggregations
3. Show "edited" tag in the dashboard Messages view

---

### 🟢 P2 — Forwarded leads count as the forwarder, not the originator

**Problem:** If Laura forwards a lead from another group to "Be Home Leads Scheduled", our parser credits Laura. Usually fine, but edge case.

**Mitigation:** Check `contextInfo.forwardingScore` in the raw message; add a small tag "(forwarded)" in the report if > 0.

---

### 🟡 P1 — `node-cron` validates some invalid cron strings

**Problem:** `cron.validate("invalid")` returns false, good. But `cron.validate("0 0 1 13 *")` (month 13) returns true and the task silently never fires.

**Mitigation:** Use `cron-parser` package for validation — it actually parses the expression and errors on semantically invalid ranges. Also use it to compute `nextFireAt` accurately.

---

### 🟡 P1 — Task failure never auto-disables

**Problem:** A scheduled task with a broken payload (e.g. webhook URL that 500s forever) keeps firing on every interval, incrementing `failureCount`. No auto-disable. The dashboard shows the count but the task never stops.

**Mitigation:** Auto-disable after 10 consecutive failures (`failureCount >= 10 && runCount - successCount >= 10`). User can re-enable manually.

---

### 🟢 P2 — `fireTask` has no execution timeout

**Problem:** If a `webhook` action hangs (slow server), the task execution blocks for however long fetch waits (default: forever). Other tasks scheduled for the same minute fire normally but the hung task ties up a timer slot.

**Mitigation:** Wrap `action.execute` in `Promise.race` with a 60-second timeout. Fail with a clear error if exceeded.

---

## Priority summary

### P0 — fix today

1. **Postgres backup** (enable EasyPanel or external cron)
2. **Rate limit on login** (in-memory, 5/15min)
3. **Deep healthcheck** (`GET /health` checks DB + Evolution)
4. **Graceful shutdown** (drain in-flight webhooks, then close)
5. **Scheduled task recovery on boot** (fire cron tasks whose nextFireAt passed during downtime)
6. **Evolution smoke test script** (poke every endpoint we use, alert on shape drift)

### P1 — fix this week

1. Tests for ingest, scheduler, status range parser
2. Staging environment on EasyPanel
3. External log shipping (Axiom/Logtail free tier)
4. External uptime monitoring (UptimeRobot)
5. Audit log of admin actions
6. Handle `MESSAGES_UPDATE` / `MESSAGES_DELETE` webhook events
7. LID resolution for new group participants (auto)
8. JWT tokenVersion for password-change revocation
9. Seed file for the 142 historical names (fallback if Config is wiped)
10. Task auto-disable after N failures
11. Alerting when sync / task / reminder has repeated failures

### P2 — later

1. Centralized logging + metrics + traces
2. Managed Postgres migration
3. Instant rollback via tagged Docker images
4. Shared types between backend and frontend
5. Timezone sanity check on boot
6. parseLead result cached on Message rows
7. Task execution timeout (60s)

---

## Fixes implemented in this audit session

See [`AUDIT-FIXES.md`](./AUDIT-FIXES.md) for the diffs committed as part of addressing the P0 items.

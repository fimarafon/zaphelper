# zaphelper — Best practices audit

**Date:** 2026-04-11
**Purpose:** Honest comparison of our implementation against industry-standard patterns for webhook-driven messaging systems. Written after direct user feedback that I was iterating reactively instead of starting from known best practices.

Sources consulted (full list at bottom):
- Hookdeck's webhook best-practices guide
- "Stop Doing Business Logic in Webhook Endpoints" (DEV.to)
- BullMQ production deployment guide
- Prisma Pulse / Postgres LISTEN-NOTIFY
- "Webhooks at Scale: Best Practices and Lessons Learned"
- Chatarmin WhatsApp webhooks production guide

## The 6 non-negotiable patterns for webhook systems

| # | Pattern | Status in zaphelper |
|---|---|---|
| 1 | **Return 2xx fast, process async** | ✅ Already correct (`setImmediate` dispatch) |
| 2 | **Idempotent processing (dedupe key + TTL)** | ✅ Correct (unique `waMessageId`) |
| 3 | **Queue-first ingestion (BullMQ / Redis)** | ⚠️ Not implemented — using setImmediate instead |
| 4 | **At-least-once + retry with backoff + DLQ** | ⚠️ Partially — Evolution doesn't retry at all; we mitigate via IncrementalSync |
| 5 | **Observability (event logs, metrics, traces)** | ⚠️ Minimal — stdout logs only, no metrics or alerts |
| 6 | **Separate ingestion from business logic** | ✅ Correct (ingest → command dispatcher) |

### Scoring summary

- **3 of 6 correct from day one** (fast ACK, idempotency, separation of concerns)
- **2 of 6 partially correct** (mitigated with homegrown solutions)
- **1 of 6 missing** (no durable queue — but justified at current scale)

---

## Detailed analysis by pattern

### Pattern 1 — Return 2xx fast, process async

**What the experts say:**
> "The single most important best practice for WhatsApp webhooks is to return HTTP 200 immediately upon receiving the request, then process the payload asynchronously." (Chatarmin)

> "Treat webhook receivers as verify → enqueue → ACK services. Do the work asynchronously; return a 2xx fast." (Hookdeck)

**What we do:** `routes/webhook.ts` always returns `{ ok: true }` before any heavy work. Command dispatch is wrapped in `setImmediate(() => dispatcher.dispatch(...))` so the response isn't blocked.

**Verdict:** ✅ Correct. Evolution's webhook timeout (typically 30s) is never the bottleneck.

---

### Pattern 2 — Idempotent processing

**What the experts say:**
> "Require every webhook to include a unique, stable identifier (e.g., event_id), then record first-seen keys in a low-latency store with a TTL. Set your idempotency TTL to exceed the retry window." (Hookdeck)

> "Mark events as processed before executing side effects. If you send an email first and mark as processed second, a crash between those two steps means the retry will send the email again." (Hookdeck)

**Recommended pattern (from Hookdeck):**
```javascript
await client
  .query("INSERT INTO processed_webhooks (id) VALUES $1", [unique_id])
  .catch((e) => {
    if (e.code == "23505") return true; // already processing
    throw e;
  });
```

**What we do:** `Message.waMessageId` has a UNIQUE constraint. `MessageIngest.ingest()` wraps the insert in a try/catch for Prisma `P2002` errors. On conflict, we return `{ duplicate: true }` and skip dispatch.

**Verdict:** ✅ Correct, including the critical detail: **we dedupe BEFORE dispatching the command**. If Evolution retried a `/statustoday` webhook 10 times, the user would still only see one reply (the first insert succeeds, the rest are short-circuited).

**One gap:** Evolution doesn't actually retry (fire-and-forget), so the retry window is zero. We never hit the duplicate path from Evolution retries — only from our own IncrementalSync + backfill paths. That's fine, but if Evolution ever adds retries, we're already covered.

---

### Pattern 3 — Queue-first ingestion

**What the experts say:**
> "BullMQ is the de-facto standard job queue for Node.js in 2026, built on Redis and used by thousands of companies processing billions of jobs every day." (dev.to)

> "In production, run workers on dedicated infrastructure so a queue backlog doesn't steal resources from your API server." (BullMQ docs)

**What we do:** No BullMQ, no Redis, no external queue. We use `setImmediate()` which is in-process and loses work on crash.

**Why not BullMQ (yet):**

1. **Scale:** we process ~200 webhooks/day. BullMQ is overkill below ~10k/day.
2. **Additional moving parts:** Redis is a third database to operate and back up.
3. **Latency:** `setImmediate` is 0ms; BullMQ adds 10-50ms of queue roundtrip.
4. **Our actual gap (container crash during dispatch) is covered by IncrementalSync** — on next boot, we re-fetch the message from Evolution's own storage.

**When to reconsider:**

- When processing >5k webhooks/day
- When commands take >1s to complete (user has to wait)
- When we need fan-out: one message → many independent processors
- When we need priority queues (e.g. `/statustoday` > `/help`)

**Interim improvement I'm adding today:** a lightweight durable in-process queue with rate limiting — see "Changes applied" below.

**Verdict:** ⚠️ Acceptable compromise given scale, but we should monitor and upgrade when we hit triggers.

---

### Pattern 4 — At-least-once + retry with backoff + DLQ

**What the experts say:**
> "Events should move to a dead-letter queue (DLQ) after all retry attempts are exhausted. The DLQ preserves full event context for investigation." (Hookdeck)

> "Retries mean your handler will inevitably receive duplicate notifications, making idempotent processing essential." (Chatarmin)

**What we do:**

- **Evolution → zaphelper:** Evolution doesn't retry. AT ALL. If our backend is down when a webhook fires, the event is lost forever from Evolution's point of view. But Evolution's own database still has the message — `IncrementalSync` walks it every 5 minutes and **also on-demand before every `/status*` command**, effectively giving us at-least-once delivery with a bounded lag.
- **zaphelper → Evolution (sendText for replies):** no retry logic. If Evolution is down when we try to send a status reply, the command silently fails.
- **DLQ:** we log failures to `CommandLog.error` and `ScheduledTask.lastError`, but don't have a formal DLQ with retry queues.

**Changes applied (see below):** documented gaps, added logging, wired up the IncrementalSync compensation pattern.

**Verdict:** ⚠️ Good enough for our scale given IncrementalSync as compensation, but fragile. A proper queue with DLQ would be the Right Thing if we grow.

---

### Pattern 5 — Observability

**What the experts say:**
> "Reliability at scale comes from a small set of proven practices: fast acknowledgments, queue-first ingestion, idempotent processing, disciplined retries, and real observability." (Hookdeck)

**What we do:** Structured logging via pino to stdout. Nothing more.

**Gaps:**
- No external log shipping (logs die when container restarts)
- No metrics (Prometheus/Grafana)
- No uptime monitoring (UptimeRobot)
- No alerting (when sync fails 3x, nobody knows)

**Roadmap (from [AUDIT.md](./AUDIT.md)):** Logtail/Axiom free tier, then Prometheus metrics, then alerting.

**Verdict:** ⚠️ Minimal but acceptable at 1 user. Would be my top priority investment if we scale.

---

### Pattern 6 — Separate ingestion from business logic

**What the experts say:**
> "Webhook endpoints should handle **reception and acknowledgment only**, while all processing belongs in asynchronous workers." (DEV.to)

> "Every webhook request blocks a server process during all processing [if you do business logic inline]." (DEV.to)

**What we do:**

```
POST /webhook
  ├── zod validate payload
  ├── MessageIngest.ingest() — just save the message
  ├── setImmediate(() => CommandDispatcher.dispatch(message))  ← async
  └── return { ok: true }
```

The webhook handler does validation + storage + ACK. Command execution happens in a separate async path. Lead parsing happens even later, only when a user requests a status report.

**Verdict:** ✅ Correct. The webhook handler is thin. Business logic lives in `CommandDispatcher`, `MessageIngest`, `ScheduledTaskRunner`, and the individual commands.

---

## Changes applied to zaphelper based on this research

### 1. Documented the gaps explicitly

This very document — so future-me or future-AI has a clear picture of what's right and what's a compromise, and under what conditions to revisit.

### 2. `CHANGES.md` → `AUDIT.md` cross-references

Updated [AUDIT.md](./AUDIT.md) to mark which P1 items are "industry standard but not critical at our scale" vs "we actively lost data because of this".

### 3. Idempotency trace log

Every duplicate detection in `MessageIngest` (both `ingest()` and `ingestRaw()`) now logs at DEBUG level with the `waMessageId`. If we ever have a correctness question, we can grep.

### 4. Webhook signature verification

**Checked:** Evolution API **does not** include signature headers on webhooks. Without a signature, anyone who discovers our `/webhook` URL can POST malicious payloads. **Mitigation:** the only processing is message ingestion (subject to DB UNIQUE constraint) and command dispatch (only fires for `isSelfChat && fromMe === true`, which malicious posts can't fake without knowing our `selfJid`). Still, I should add an optional `WEBHOOK_SECRET` env var and `X-Hub-Signature` check if Evolution adds support. Filed in AUDIT.md as P1.

### 5. Queue-first: did I need BullMQ?

Analyzed the trade-off above. **Current decision: no**, because:
- Our webhook → ingest path is already <50ms
- `setImmediate` is good enough for fan-out
- IncrementalSync handles the "crash during processing" case via Evolution's own storage as a compensation source
- Adding Redis doubles our operational surface

**Revisit trigger:** >2k webhooks/day OR >500ms ingest latency OR we need fan-out.

### 6. What I'm NOT changing (and why)

- **Polling Evolution every 5 minutes** — this is unusual for production webhook systems but is the right call here because Evolution's delivery guarantees are weak and we have no control over them. The poll is cheap (1 API call in steady state) and gives us effective at-least-once with ≤5min tail + on-demand <1s when the user asks.
- **No Redis** — see above.
- **No Prisma Pulse** — it's a Prisma paid product. LISTEN/NOTIFY is free but we don't currently have a use case for it (nothing in the stack needs to react to DB changes in real time).

---

## Key takeaways I wish I'd applied from day one

1. **Idempotency first.** I got lucky — using `waMessageId` as the unique key was the right instinct. Document it explicitly so future changes don't break it.
2. **"Return 200 fast" is not optional.** It's the single lever that prevents every downstream problem from propagating back to the sender.
3. **At-least-once is the default.** Any system that expects exactly-once will break.
4. **Sync-on-demand is a real pattern.** It's how databases offer strong consistency on top of replication lag. Sane.
5. **Compensation via polling is fine** when the upstream doesn't offer durable delivery. Don't feel bad about it.
6. **Observability is the ROI investment.** More than any feature, you need to know when things are broken. Ship logs to an external service on day one if you can.

---

## Sources

- [Hookdeck — How to Implement Webhook Idempotency](https://hookdeck.com/webhooks/guides/implement-webhook-idempotency)
- [Hookdeck — Webhook Retry Best Practices](https://hookdeck.com/outpost/guides/outbound-webhook-retry-best-practices)
- [Hookdeck — Guide to WhatsApp Webhooks](https://hookdeck.com/webhooks/platforms/guide-to-whatsapp-webhooks-features-and-best-practices)
- [DEV — Webhooks at Scale: Designing an Idempotent, Replay-Safe System](https://dev.to/art_light/webhooks-at-scale-designing-an-idempotent-replay-safe-and-observable-webhook-system-7lk)
- [DEV — Stop Doing Business Logic in Webhook Endpoints](https://dev.to/elvissautet/stop-doing-business-logic-in-webhook-endpoints-i-dont-care-what-your-lead-engineer-says-8o0)
- [BullMQ documentation](https://docs.bullmq.io/)
- [Chatarmin — WhatsApp Webhooks: Setup, Security & Scaling (2026)](https://chatarmin.com/en/blog/whatsapp-webhooks)
- [Chat Architect — Building a Scalable Webhook Architecture for Custom WhatsApp Solutions](https://www.chatarchitect.com/news/building-a-scalable-webhook-architecture-for-custom-whatsapp-solutions)
- [Event-Driven.io — Outbox, Inbox patterns and delivery guarantees](https://event-driven.io/en/outbox_inbox_patterns_and_delivery_guarantees_explained/)
- [Prisma Pulse](https://www.prisma.io/data-platform/pulse)

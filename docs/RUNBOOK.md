# zaphelper — Runbook

Operational playbook for the most common problems. Read this when something is broken before diving into code.

## 🚨 Quick triage

When something feels off, run these in order:

### 1. Is the dashboard reachable?

```bash
curl -sk https://zaphelper.maverstudio.com/health | jq
```

Expected:

```json
{
  "ok": true,
  "ts": "2026-04-11T20:00:00.000Z",
  "checks": {
    "db": { "ok": true, "latencyMs": 12 },
    "evolution": { "ok": true, "latencyMs": 85 },
    "selfIdentity": { "ok": true }
  }
}
```

If not reachable at all → **Problem P1** (infrastructure down).
If `ok: false` → check which sub-check failed.

### 2. Is Evolution reachable?

```bash
curl -s -H "apikey: $EVO_KEY" https://evolution.maverstudio.com/instance/connectionState/zaphelper-main
```

Expected:
```json
{"instance":{"instanceName":"zaphelper-main","state":"open"}}
```

If `state: "close"` → **Problem P2** (WhatsApp session kicked).
If connection refused → Evolution itself is down (**Problem P7**).

### 3. Are new messages landing in the DB?

```bash
curl -s -b cookies.txt 'https://zaphelper.maverstudio.com/api/messages?limit=1' \
  | jq -r '.items[0].timestamp'
```

Compare to now — should be recent (minutes, not hours). If stale → **Problem P3** (ingest broken).

### 4. Are scheduled tasks firing?

```bash
curl -s -b cookies.txt https://zaphelper.maverstudio.com/api/schedules \
  | jq '.items[] | {name, enabled, lastFiredAt, failureCount, lastError}'
```

Check `lastFiredAt` for each enabled task — should match the schedule. If failing → **Problem P4** (task runner broken).

---

## Problems and fixes

### P1 — Dashboard is completely unreachable

**Symptoms:**
- `curl` returns connection refused or timeout
- Browser shows "site can't be reached"

**Cause options (in order of likelihood):**

1. **nginx container is down**
   - Check EasyPanel → studio_zaphelper-web status
   - Fix: restart service
2. **Traefik (EasyPanel proxy) is down**
   - Check EasyPanel dashboard itself is accessible
   - Fix: restart EasyPanel from VPS SSH
3. **VPS is down**
   - SSH to `root@72.60.2.53` — if refused, VPS is dead
   - Fix: reboot via Hostinger control panel
4. **DNS broken**
   - `dig zaphelper.maverstudio.com` should return `72.60.2.53`
   - Fix: Hostinger DNS panel

**Recovery priority:** get the dashboard back up. Data is safe as long as Postgres volume is intact.

---

### P2 — WhatsApp session disconnected (`device_removed`)

**Symptoms:**
- Dashboard shows "DISCONNECTED" state
- `/health` shows `checks.selfIdentity.ok: true` but messages aren't flowing
- Evolution `connectionState` returns `close`
- In Evolution fetchInstances, `disconnectionReasonCode: 401` with `type: "device_removed"`

**Root cause:** WhatsApp allows up to 4 linked devices. Filipe linked a new device and the oldest one (zaphelper-main) got kicked.

**Fix:**

1. Go to dashboard `https://zaphelper.maverstudio.com`
2. Click "Connect WhatsApp"
3. Scan the QR code with Filipe's phone
4. Wait ~5 seconds for state to flip to `CONNECTED`
5. Run a manual backfill to catch up messages that arrived while disconnected:
   ```bash
   curl -X POST -b cookies.txt -H "Content-Type: application/json" -d '{}' \
     https://zaphelper.maverstudio.com/api/instance/backfill
   ```
6. Verify with `/statustoday` — should reflect recent leads

**Prevention:** keep an eye on how many devices are linked to Filipe's WhatsApp (Settings → Linked Devices). Remove unused ones.

---

### P3 — Messages not arriving in real-time

**Symptoms:**
- `/statustoday` returns fewer leads than expected
- `/api/messages?limit=1` shows a stale timestamp
- Evolution has new messages (`/chat/findMessages` returns them) but zaphelper DB doesn't

**Cause options:**

1. **Webhook URL drift** — Evolution's webhook config points somewhere else
   - Check: `curl -H "apikey: $EVO_KEY" https://evolution.maverstudio.com/webhook/find/zaphelper-main`
   - Expected: `url: "https://zaphelper.maverstudio.com/webhook"`
   - Fix: PATCH it back, or restart backend (it re-asserts on boot)

2. **Backend crashed mid-process** — the message reached the webhook but MessageIngest threw
   - Check backend logs in EasyPanel for stack traces
   - Fix: restart backend, run backfill to catch up

3. **IncrementalSync is broken** — fallback isn't covering the gap
   - Check backend logs for "Sync cycle complete" / "Sync cycle failed" entries
   - Fix: manual backfill while you debug

**Immediate unblock (buys you 5 min while you investigate):**

```bash
curl -X POST -b cookies.txt -H "Content-Type: application/json" -d '{}' \
  --max-time 600 \
  https://zaphelper.maverstudio.com/api/instance/backfill
```

Returns a summary showing how many new messages were saved.

---

### P4 — Scheduled tasks not firing

**Symptoms:**
- Tasks have `lastFiredAt` much older than their cron schedule suggests
- Or `failureCount` is climbing
- Or task was auto-disabled (got a "Task auto-disabled" notification)

**Cause options:**

1. **Task was auto-disabled after 10 failures**
   - Check `/api/schedules` → look for `enabled: false` with a recent `lastError`
   - Fix: examine the error, fix the underlying issue (broken webhook URL, missing API key, etc.), then re-enable via the dashboard

2. **Cron expression is wrong**
   - `nextFireAt` in the DB shows the computed next fire time
   - Use <https://crontab.guru> to verify the expression
   - Fix: edit the task, update the cron

3. **Timezone drift**
   - Task meant to run at 9am LA is firing at 9am UTC
   - Check: `TZ` env var on the backend container
   - Fix: set `TZ=America/Los_Angeles` and redeploy

4. **Backend crashed right at the fire time**
   - The task recovery logic on boot should catch this (fires with `[missed]` prefix)
   - But if the backend is crash-looping, recovery also fails
   - Fix: stabilize the backend first, then tasks recover automatically

---

### P5 — `/statustoday` returns 0 but you know there are leads

**Check in order:**

1. **Is today today?** — `TZ` env var might be wrong, shifting "today" by several hours
   - Check: `curl -s https://zaphelper.maverstudio.com/health | jq .ts` → compare to your local time
2. **Does the group name still match?** — The query uses `chatName contains "Be Home Leads Scheduled"`
   - Check: `curl -b cookies.txt 'https://zaphelper.maverstudio.com/api/messages/chats' | jq '.chats[] | select(.isGroup)'`
   - If the group was renamed, update `BE_HOME_LEADS_GROUP_NAME` env var
3. **Are the messages actually in the DB?**
   - Check: `curl -b cookies.txt 'https://zaphelper.maverstudio.com/api/messages?chatName=Be%20Home&limit=10'`
   - If empty → back to Problem P3
4. **Is the parser skipping them?**
   - Run `/audit` to see skipped messages with reason
   - `no_signal` means they don't match lead heuristics — maybe the group format changed

**Fix:** usually P3 followed by `/audit` confirms the issue.

---

### P6 — Login doesn't work

**Symptoms:**
- "Invalid credentials" even with the right password
- 429 "Too many login attempts"

**For 429:** rate-limited. Wait 15 minutes or bypass by restarting the backend container (clears the in-memory limiter).

**For "Invalid credentials":**

1. **Password is actually wrong** — yes, check
2. **Hash got mangled in env** — happens if bash ate a `$`. Check length:
   ```bash
   curl -s -G -H "Authorization: Bearer $EP_KEY" \
     --data-urlencode 'input={"json":{"projectName":"studio","serviceName":"zaphelper-backend"}}' \
     'https://easypanel.maverstudio.com/api/trpc/services.app.inspectService' \
     | jq -r '.result.data.json.env' | grep ADMIN_PASSWORD_HASH
   ```
   Hash should be exactly 60 characters after `=`. If it's shorter, regenerate and update via the Python API workflow (NOT bash interpolation).
3. **ADMIN_USER mismatch** — check the env var, make sure it matches what you're typing

**Reset password procedure:**

```python
import json, urllib.request

AUTH = "Bearer <EASYPANEL_API_KEY>"
BASE = "https://easypanel.maverstudio.com/api/trpc"

# 1. Generate fresh hash
import subprocess
new_pass = "your-new-password"
hash_result = subprocess.run(
    ["node", "-e", f"console.log(require('bcryptjs').hashSync('{new_pass}', 10))"],
    capture_output=True, text=True
)
new_hash = hash_result.stdout.strip()
assert len(new_hash) == 60, f"Hash wrong length: {len(new_hash)}"

# 2. Fetch current env
import urllib.parse
params = urllib.parse.quote(json.dumps({"json": {"projectName": "studio", "serviceName": "zaphelper-backend"}}))
req = urllib.request.Request(f"{BASE}/services.app.inspectService?input={params}",
                             headers={"Authorization": AUTH})
env = json.loads(urllib.request.urlopen(req).read())["result"]["data"]["json"]["env"]

# 3. Update
new_env = "\n".join(
    f"ADMIN_PASSWORD_HASH={new_hash}" if line.startswith("ADMIN_PASSWORD_HASH=") else line
    for line in env.split("\n")
)
req = urllib.request.Request(f"{BASE}/services.app.updateEnv",
    data=json.dumps({"json": {"projectName": "studio", "serviceName": "zaphelper-backend", "env": new_env}}).encode(),
    headers={"Authorization": AUTH, "Content-Type": "application/json"}, method="POST")
urllib.request.urlopen(req).read()

# 4. Trigger redeploy
req = urllib.request.Request(f"{BASE}/services.app.deployService",
    data=json.dumps({"json": {"projectName": "studio", "serviceName": "zaphelper-backend", "forceRebuild": False}}).encode(),
    headers={"Authorization": AUTH, "Content-Type": "application/json"}, method="POST")
urllib.request.urlopen(req).read()

print("Password changed. New creds active after ~20s.")
```

---

### P7 — Evolution API is down

**Symptoms:**
- `/health` shows `checks.evolution.ok: false`
- Manual calls to `evolution.maverstudio.com` return connection refused or 502
- IncrementalSync logs show "Sync cycle failed"
- No new messages coming in at all

**Fix:**

1. SSH to VPS
2. Check the Evolution container: `docker ps | grep evolution`
3. If stopped: restart via EasyPanel → maver project → evolution-api service → Deploy
4. If crashing: check its logs, usually it's a database connection issue or an out-of-memory error
5. If persistent: rollback Evolution to a known-good image tag

**Once Evolution is back:**

- Webhooks will start arriving again automatically
- IncrementalSync will catch up on the next 5-minute cycle
- Connection state in zaphelper flips to CONNECTED
- Run a manual backfill for safety

---

### P8 — Postgres is down

**Symptoms:**
- `/health` → `checks.db.ok: false`
- Backend is crash-looping with `Can't reach database server`

**Fix:**

1. SSH to VPS
2. `docker ps | grep postgres` — is the container running?
3. If stopped: `docker start studio_zaphelper-postgres` or EasyPanel restart
4. Check logs: `docker logs studio_zaphelper-postgres --tail 100`
5. If the volume is corrupted (rare): **you need a backup**. See AUDIT.md for why this is urgent.

**Data loss scenarios:**

- Container restarted cleanly: zero data loss, volume is intact
- Disk failure: **total loss** unless you have backups
- Accidental `docker volume rm`: **total loss**

If backups exist, restore:

```bash
cat zaphelper-2026-04-11.sql | docker exec -i studio_zaphelper-postgres \
  psql -U postgres studio
```

Then start the backend to verify.

---

### P9 — `/reminder` command doesn't fire

**Symptoms:**
- You set a reminder for `2026-04-12 09:00`, that time passes, nothing happens

**Debug:**

1. Check the reminder exists: `/reminders` in WhatsApp, should show it as PENDING
2. Check scheduler started at boot: EasyPanel → backend logs → grep "Scheduler started" — should include `loaded: N` where N includes your reminder
3. Check the fire log: grep for "Reminder sent" at around the fire time
4. Check for errors: grep "Reminder fire failed"

**Common causes:**

1. **Backend was restarted between creation and fire** — on next boot, reminder becomes MISSED and fires immediately with `[Missed reminder]` prefix. Check your self-chat for that message.
2. **Self identity is not known** — scheduler can't send without a phone. Check `/api/instance/status` for `selfPhone`.
3. **Evolution was down at fire time** — reminder marked FAILED with the error. Check `/api/reminders?status=FAILED`.

**Manual unstick:**

```bash
# Re-schedule a FAILED reminder as PENDING
# (currently no API for this, needs a direct DB update via prisma studio or SQL)
```

TODO: add `POST /api/reminders/:id/retry` endpoint.

---

### P10 — Dashboard shows old data (cache)

**Symptoms:**
- Created a new schedule but it's not in the list
- Commands page doesn't show a command you just ran

**Fix:**

- Dashboard uses TanStack Query with various `staleTime` values (usually 5-30s)
- Hard refresh (`Cmd+Shift+R`) bypasses React Query cache
- Or wait for the refetchInterval to tick (usually 10-30s)

If data still doesn't update after a hard refresh → it's not a cache issue, it's a backend issue. Go back to triage.

---

## Common commands for investigation

### Check current state

```bash
# Live backend logs (from EasyPanel UI, or via API)
# Easier: EasyPanel dashboard → service → Logs tab

# Last 50 messages ingested
curl -s -b cookies.txt 'https://zaphelper.maverstudio.com/api/messages?limit=50' \
  | jq '.items | reverse | .[] | {timestamp, senderName, content: .content[0:60]}'

# Current incoming message rate
# (no API yet — infer from the count of messages in the last hour)
```

### Force actions

```bash
# Backfill
curl -X POST -b cookies.txt -H "Content-Type: application/json" -d '{}' \
  --max-time 600 https://zaphelper.maverstudio.com/api/instance/backfill

# Re-import names
curl -X POST -b cookies.txt -H "Content-Type: application/json" \
  -d '{"sourceInstance": "markar-a3525386"}' \
  https://zaphelper.maverstudio.com/api/instance/import-names

# Run a command
curl -X POST -b cookies.txt -H "Content-Type: application/json" \
  -d '{"input":"/statustoday"}' \
  https://zaphelper.maverstudio.com/api/commands/run

# Reconnect WhatsApp (generates fresh QR)
curl -X POST -b cookies.txt -H "Content-Type: application/json" \
  https://zaphelper.maverstudio.com/api/instance/connect
```

### DB inspection (requires VPS access)

```bash
# SSH to VPS
ssh root@72.60.2.53

# Connect to Postgres
docker exec -it studio_zaphelper-postgres psql -U postgres studio

# Useful queries
SELECT COUNT(*) FROM "Message";
SELECT "senderName", COUNT(*) FROM "Message" WHERE "chatName" ILIKE '%Be Home%' GROUP BY 1 ORDER BY 2 DESC;
SELECT "key", "value" FROM "Config" WHERE "key" LIKE 'name:%' LIMIT 20;
SELECT "name", "enabled", "lastFiredAt", "failureCount", "lastError" FROM "ScheduledTask" ORDER BY "createdAt" DESC;
```

## Escalation

This is a single-user project, so "escalation" means: read the source code.

Start points by component:

- **Webhook flow**: `backend/src/routes/webhook.ts` → `services/message-ingest.ts`
- **Commands**: `services/command-dispatcher.ts` + `commands/registry.ts`
- **Scheduled tasks**: `services/scheduled-task-runner.ts`
- **Reminders**: `services/scheduler.ts`
- **Evolution quirks**: `evolution/client.ts` + [EVOLUTION-INTEGRATION.md](./EVOLUTION-INTEGRATION.md)
- **Parser logic**: `services/lead-parser.ts`

When in doubt, turn on debug logging (`LOG_LEVEL=debug` — not implemented yet as an env var but you can edit `logger.ts` temporarily) and reproduce the issue.

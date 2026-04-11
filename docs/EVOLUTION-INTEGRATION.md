# zaphelper — Evolution API integration

Deep dive on how zaphelper talks to [Evolution API](https://github.com/EvolutionAPI/evolution-api), what endpoints we depend on, and the quirks we've had to work around.

**Current Evolution version:** 2.3.7 (as of 2026-04-11)
**Instance we manage:** `zaphelper-main` on `https://evolution.maverstudio.com`

## Endpoints we use

All requests include the header `apikey: <EVOLUTION_API_KEY>` (admin key). The wrapper lives in `backend/src/evolution/client.ts`.

### Instance management

| Method | Path | Purpose | Where |
|---|---|---|---|
| `POST` | `/instance/create` | Create a new instance with webhook config | `createInstance()` |
| `GET` | `/instance/fetchInstances` | List all instances (used to detect the user's JID) | `fetchInstances()`, `detectOwnerJid()` |
| `GET` | `/instance/connectionState/{name}` | Get current state (open/connecting/close) | `getConnectionState()` |
| `GET` | `/instance/connect/{name}` | Returns a QR code (base64) for pairing | `connect()` |
| `DELETE` | `/instance/logout/{name}` | Disconnect WhatsApp session | `logout()` |
| `DELETE` | `/instance/delete/{name}` | Delete the entire instance | `deleteInstance()` (not currently called) |
| `POST` | `/webhook/set/{name}` | Update the webhook URL and events | `setWebhook()` |
| `GET` | `/webhook/find/{name}` | Read current webhook config (not in client, only used for debugging) |

### Messaging

| Method | Path | Purpose | Where |
|---|---|---|---|
| `POST` | `/message/sendText/{name}` | Send a plain text message | `sendText()` |
| `POST` | `/message/sendMedia/{name}` | Send image/video/audio/document | `sendMedia()` |

### Discovery

| Method | Path | Purpose | Where |
|---|---|---|---|
| `POST` | `/group/findGroupInfos/{name}` | Fetch one group's subject (used as fallback) | `getGroupInfo()` |
| `GET` | `/group/fetchAllGroups/{name}?getParticipants=<bool>` | List all groups, optionally with participants | `fetchAllGroups(withParticipants)` |
| `POST` | `/chat/fetchProfilePictureUrl/{name}` | Get a profile picture URL | `getProfilePicture()` |
| `POST` | `/chat/whatsappNumbers/{name}` | Check if a number exists on WA | `checkNumberExists()` |
| `POST` | `/chat/fetchProfile/{name}` | Fetch a number's public profile (includes `name` if set) | `fetchProfile()` |
| `POST` | `/chat/findChats/{name}` | List all chats | `fetchAllChats()` |
| `POST` | `/chat/findContacts/{name}` | List all contacts | `fetchAllContacts()` |
| `POST` | `/chat/findMessages/{name}` | Paginated message list — the backbone of backfill + incremental sync | `fetchMessagesPage()` |

## Webhook payload shape

The body Evolution posts to `/webhook` (for `MESSAGES_UPSERT`):

```json
{
  "event": "messages.upsert",
  "instance": "zaphelper-main",
  "data": {
    "key": {
      "remoteJid": "120363396996770368@g.us",
      "fromMe": false,
      "id": "3EB0F91D63789A273BBF83",
      "participant": "46820109590596@lid"
    },
    "message": {
      "conversation": "Laura\n+1 555...",
      "messageContextInfo": {...}
    },
    "pushName": "Laura",
    "messageType": "conversation",
    "messageTimestamp": 1775865468
  }
}
```

For `CONNECTION_UPDATE`:

```json
{
  "event": "connection.update",
  "instance": "zaphelper-main",
  "data": {
    "state": "open"
  }
}
```

We accept both `event` with dots (`messages.upsert`) and underscores (`messages_upsert`) — different Evolution versions use different conventions.

## Known quirks

### 1. Webhook events fire-and-forget, no retry

**What we observed:** when the zaphelper backend was down for 30 seconds during a deploy, ~13 messages that arrived in that window were never delivered. Evolution logged the failure and moved on. Zero retry.

**Mitigation:** `IncrementalSync` polls `/chat/findMessages` every 5 minutes as a safety net. See [ARCHITECTURE.md § Path 2](./ARCHITECTURE.md#path-2--backfill--incremental-sync-safety-net).

### 2. WhatsApp LID privacy system breaks pushName for historical messages

**The problem:** WhatsApp introduced "LID" (Local Identifier) — an opaque per-account ID that replaces real phone numbers in group messages for privacy. When we sync historical messages from `/chat/findMessages`, the `pushName` field comes as the LID digits (e.g. `"46820109590596"`) instead of the real name (`"Laura"`).

**Why:** Baileys (the library Evolution wraps) only receives real pushNames when a message arrives **in real-time** via the `messages.upsert` event with `type: "notify"`. During sync of historical messages (`type: "append"`), pushName defaults to the LID.

**Workaround we implemented:**

1. Use `/group/fetchAllGroups?getParticipants=true` to get the LID → phoneNumber mapping (Evolution 2.3.5+ exposes this)
2. Use `/chat/findContacts` to get phone → pushName (for contacts the user has saved)
3. Use `/chat/fetchProfile` as a fallback for unsaved numbers (returns `name` only if the person has a public profile name set)
4. **Import from a legacy instance** (`markar-a3525386`) that had been connected live for months and accumulated the real pushNames in its own message database
5. Persist the resulting phone → name map in our `Config` table as `name:<phone>` entries so it survives restarts

The import endpoint is `POST /api/instance/import-names` with body `{ "sourceInstance": "markar-a3525386", "maxPages": 500 }`.

**Ongoing handling:** when **new** messages arrive via webhook (real-time), the `pushName` IS the real name. The `MessageIngest` reads it and only falls back to the Config map if pushName is numeric.

**Related issues:**

- [Evolution API #2267](https://github.com/EvolutionAPI/evolution-api/issues/2267) — pushName null for @lid messages from ads
- [Evolution API #2426](https://github.com/EvolutionAPI/evolution-api/issues/2426) — Contact.pushName overwritten with empty string on own-message sends
- [Evolution API #2004](https://github.com/EvolutionAPI/evolution-api/issues/2004) — findContacts returns empty pushName
- [Baileys #1554](https://github.com/WhiskeySockets/Baileys/issues/1554) — LID → JID resolution is one-way (you can get LID from phone, not the other way)

### 3. `/chat/findChats` must be POST

Older Evolution versions accepted GET, but 2.3.7 requires POST with a `{ "where": {} }` body. Our client uses POST.

### 4. `/chat/findMessages` pagination

Returns `{ messages: { total, pages, currentPage, records } }`. Page 1 has the newest records (descending by timestamp). `offset` is the page size (default 100). Setting `where.key.remoteJid` filters by a specific chat.

To walk all messages for a chat:

```typescript
let page = 1;
while (true) {
  const { messages } = await client.fetchMessagesPage(page, 100);
  // process messages.records
  if (page >= messages.pages) break;
  page++;
}
```

### 5. `/group/participants` response shape varies

On Evolution 2.3.5+, `GET /group/participants/{name}?groupJid={jid}` returns:

```json
{
  "participants": [
    {
      "id": "87909424230589@lid",
      "phoneNumber": "12543343617@s.whatsapp.net",
      "admin": null
    },
    {
      "id": "90306099822759@lid",
      "phoneNumber": "16198886149@s.whatsapp.net",
      "admin": null,
      "name": null,
      "imgUrl": "https://..."
    }
  ]
}
```

Note that `name` and `imgUrl` are only populated for the owner's own participant, not others. This limits how much auto-resolution we can do via this endpoint.

### 6. Pushing invalid webhook URLs silently disables the webhook

If you set `WEBHOOK_URL` to a malformed URL (e.g. missing scheme), Evolution accepts the config but silently doesn't fire. Always ensure the URL starts with `https://`.

### 7. `device_removed` error kicks the instance

WhatsApp allows up to 4 linked devices. If the user scans a QR on a 5th device, WhatsApp kicks the oldest linked device, which for zaphelper means our Baileys session gets a `Stream Errored (conflict) { type: device_removed }` and disconnects. `connectionStatus` becomes `close` with `disconnectionReasonCode: 401`.

**Impact:** webhooks stop firing until someone reconnects.

**Detection:** the dashboard Dashboard page polls `/api/instance/status` every 15s and shows the state. The incremental sync will also start failing if Evolution itself returns "instance not connected" errors.

**Recovery:** open the dashboard → click "Connect WhatsApp" → scan the new QR with the phone.

### 8. Base64 data URIs in sendMedia

Evolution accepts `media: "data:audio/mpeg;base64,..."` for `sendMedia`, which is how the `sendVoice` action ships ElevenLabs-synthesized audio. Confirmed working on 2.3.7. Older versions may require a public URL instead.

### 9. The API key has scope: ALL instances

The `EVOLUTION_API_KEY` we use is the **admin key** that gives full access to every instance on `evolution.maverstudio.com`. This is Evolution's design — there's no per-instance key that a client can use safely. Be very careful with this key; see [AUDIT.md § Security](./AUDIT.md#security) for mitigation advice.

## Webhook setup on boot

When the backend starts, it calls `ensureInstance()` which:

1. `fetchInstances()` — checks if `zaphelper-main` exists
2. If missing: `createInstance()` with webhook config embedded
3. Always: `setWebhook()` to re-assert the URL (in case it drifted)
4. Returns the current `connectionState`

This is best-effort — if Evolution is unreachable at boot, the error is logged but doesn't block startup. The incremental sync will eventually establish contact.

## Testing the Evolution connection

**Quick smoke test from your shell:**

```bash
EVO_URL="https://evolution.maverstudio.com"
KEY="<your-api-key>"

# 1. Is Evolution alive?
curl -s "$EVO_URL/"
# Expected: {"status":200,"message":"Welcome to the Evolution API...","version":"2.3.7",...}

# 2. Is our instance registered?
curl -s -H "apikey: $KEY" "$EVO_URL/instance/fetchInstances" | jq '.[] | select(.name=="zaphelper-main") | {name, connectionStatus, ownerJid, profileName}'

# 3. Is it connected?
curl -s -H "apikey: $KEY" "$EVO_URL/instance/connectionState/zaphelper-main"
# Expected: {"instance":{"instanceName":"zaphelper-main","state":"open"}}

# 4. Does the webhook point at us?
curl -s -H "apikey: $KEY" "$EVO_URL/webhook/find/zaphelper-main"
# Expected: url is https://zaphelper.maverstudio.com/webhook, enabled:true, events has MESSAGES_UPSERT

# 5. Can we actually send a message to ourselves?
curl -X POST -H "apikey: $KEY" -H "Content-Type: application/json" \
  -d '{"number":"16198886149","text":"smoke test from curl"}' \
  "$EVO_URL/message/sendText/zaphelper-main"
```

If any of these fail, the issue is on the Evolution side, not ours.

## Upgrading Evolution

Evolution is under active development. Breaking changes happen. Protocol for upgrades:

1. **Don't do it casually.** Read the [CHANGELOG](https://github.com/EvolutionAPI/evolution-api/blob/main/CHANGELOG.md) for the version jump.
2. **Test in staging first** (when we have one). The main risks are:
   - Webhook payload shape changes (would break our `webhook-types.ts` zod schema)
   - Endpoint path changes (would break the client)
   - Authentication changes
3. **Run the smoke test above** after upgrade
4. **Trigger a manual `/api/instance/backfill`** and verify it reaches `saved > 0`
5. **Check the lead parser** — post a test message in the Be Home group and see if `/statustoday` reflects it within 5 minutes

**Version pinning:** Evolution runs in the shared `maver` project on EasyPanel as a separate container. You control its image tag there. Pin to a specific 2.3.x minor version and only upgrade deliberately.

## When Evolution is down

If Evolution is totally offline:

- Webhooks stop arriving → new messages don't show up in our DB
- Incremental sync fails → logs warnings
- `/health` returns 503 because `getConnectionState()` throws
- Dashboard shows "DISCONNECTED" or "ERROR" state
- Commands that need to send replies fail silently (the backend logs the error)

**Recovery is automatic** once Evolution comes back. The incremental sync catches up within the next 5-minute cycle.

## Quota/cost considerations

Evolution API is self-hosted so there's no per-call cost. The limiting factor is the VPS the shared Evolution runs on.

At current load:

- ~200 webhook events/day
- 1 incremental sync every 5 min = 288/day (calls /chat/findMessages, /group/fetchAllGroups, /chat/findContacts)
- Occasional `/chat/fetchProfile` lookups during backfill

Total: < 1000 Evolution API calls/day. Trivial load.

## Future improvements

- **Retry on 5xx in our client:** we retry GETs twice but POSTs are single-attempt. Consider exponential backoff with jitter for idempotent POSTs.
- **Circuit breaker:** if 5 consecutive calls fail, stop trying for 30 seconds to give Evolution room to recover.
- **Per-instance API key:** if Evolution ever adds scoped tokens, switch to one so we don't have god-mode access.
- **Evolution version detection:** smoke test endpoint shapes on boot, log deprecation warnings if drift is detected.

# zaphelper — Scheduled Task Actions

The generic scheduled-task system lets you trigger **any pluggable action** on a cron schedule or at a specific one-shot time. This doc explains the 4 built-in action types, their payload schemas, and how to add a new one.

## How scheduled tasks work

```
ScheduledTask (row in DB)
   ├── cronExpression OR fireAt    (when)
   ├── actionType                  (what — string key into ActionRegistry)
   └── actionPayload (JSON)        (how — validated by the action's zod schema)

On fire:
   ScheduledTaskRunner.fireTask()
      → loads the task from DB
      → looks up Action by actionType in ActionRegistry
      → zod-validates payload
      → runs action.execute(ctx, payload) with a 60s timeout
      → updates lastFiredAt, runCount, failureCount, lastError, lastResult
      → if 10 consecutive failures → auto-disable + notify user via self-chat
```

## Action interface

```typescript
interface Action<P = unknown> {
  type: string;                                          // unique id
  description: string;                                   // shown in the dropdown
  validatePayload?: (payload: unknown) => void;          // throws on failure
  execute: (ctx: ActionContext, payload: P) => Promise<ActionResult>;
}

interface ActionContext {
  prisma: PrismaClient;
  evolution: EvolutionClient;
  selfIdentity: SelfIdentity;
  config: AppConfig;
  logger: Logger;
  taskId: string;
  runInlineCommand?: (input: string) => Promise<{ success: boolean; reply: string }>;
}

interface ActionResult {
  success: boolean;
  output: string;                                        // stored in lastResult (truncated to 500)
  error?: string;
}
```

## Built-in actions

### 1. `sendText`

Sends a plain WhatsApp text message via Evolution API.

**Payload:**

```typescript
{
  to: string;    // phone digits OR the literal string "self"
  text: string;  // message body (supports WA markdown: *bold*, _italic_)
}
```

**Examples:**

```json
{ "to": "self", "text": "Good morning Filipe! Ready to rock?" }
```

```json
{ "to": "14155551234", "text": "Reminder: your appointment is at 3pm" }
```

**Source:** `backend/src/actions/send-text.action.ts`

**Notes:**

- `to: "self"` resolves to `selfIdentity.getPhone()` at fire time
- The message goes via `evolution.sendText()`
- If Evolution is down, the action returns `{ success: false, error }` and `failureCount` increments
- Fast: usually 200-500ms

---

### 2. `runCommand`

Executes an internal zaphelper slash command (e.g. `/statusweek`) and optionally delivers the reply to self-chat.

**Payload:**

```typescript
{
  command: string;          // must start with "/"
  deliverToSelf?: boolean;  // default true
}
```

**Examples:**

```json
{ "command": "/statusweek", "deliverToSelf": true }
```

```json
{ "command": "/reminders" }
```

**Use cases:**

- **Daily morning report:** `cron: "0 8 * * *"`, `command: "/statustoday"` → every day at 8am, the current day's lead summary lands in your self-chat
- **Weekly Monday report:** `cron: "0 9 * * 1"`, `command: "/statusweek"`
- **Month-end report:** `cron: "0 18 L * *"` (note: `L` for last day-of-month needs cron-parser, works here), `command: "/statusmonth"`

**How it works:** `runCommandAction` calls back into `CommandDispatcher.runInline()` which is the same code path as the dashboard's "Run" button. The command's reply is captured into `ActionResult.output` (truncated for storage) and optionally re-sent to self-chat so the user sees it in WhatsApp.

**Source:** `backend/src/actions/run-command.action.ts`

---

### 3. `webhook`

Fires an HTTP request to an external URL. Designed for integrations with n8n, Zapier, Make, custom APIs, etc.

**Payload:**

```typescript
{
  url: string;                                // must be a valid URL
  method?: "GET" | "POST" | "PUT" | "PATCH"; // default POST
  body?: unknown;                             // auto-stringified if object, sent as JSON
  headers?: Record<string, string>;          // extra headers (e.g. Authorization)
  deliverResponse?: boolean;                  // default false — if true, delivers the response body to self-chat
}
```

**Examples:**

**Trigger an n8n workflow daily:**
```json
{
  "url": "https://n8n.maverstudio.com/webhook/daily-trigger",
  "method": "POST",
  "body": { "source": "zaphelper", "type": "daily_check" }
}
```

**Ping an uptime monitoring healthcheck:**
```json
{
  "url": "https://hc-ping.com/your-uuid",
  "method": "GET"
}
```

**Call a CRM API with auth:**
```json
{
  "url": "https://api.example.com/leads/sync",
  "method": "POST",
  "headers": { "Authorization": "Bearer xxx" },
  "body": { "since": "yesterday" },
  "deliverResponse": true
}
```

**Behavior:**

- Any non-2xx response is treated as `success: false` and counts toward `failureCount`
- If `deliverResponse: true`, the response body (first 1500 chars) is wrapped in a code block and sent to self-chat
- No retry on failure — the next scheduled run is the retry

**Source:** `backend/src/actions/webhook.action.ts`

---

### 4. `sendVoice`

Synthesizes text via ElevenLabs and sends it as a WhatsApp voice note. **Requires `ELEVENLABS_API_KEY` env var.**

**Payload:**

```typescript
{
  to: string;                                         // "self" or phone digits
  text: string;                                       // max 5000 chars
  voiceId?: string;                                   // default "21m00Tcm4TlvDq8ikWAM" (Rachel)
  modelId?: "eleven_turbo_v2_5" | "eleven_multilingual_v2" | "eleven_monolingual_v1";
}
```

**Example:**

```json
{
  "to": "self",
  "text": "Good morning Filipe. You have 3 leads to follow up today.",
  "voiceId": "21m00Tcm4TlvDq8ikWAM",
  "modelId": "eleven_turbo_v2_5"
}
```

**How it works:**

1. POST to `https://api.elevenlabs.io/v1/text-to-speech/{voiceId}` with text + model + voice settings
2. Response is MP3 bytes
3. Base64-encode → `data:audio/mpeg;base64,...`
4. Pass to `evolution.sendMedia(phone, dataUri, "audio")`

**Gotchas:**

- **API key required:** Set `ELEVENLABS_API_KEY` in the EasyPanel backend service env. Without it, the action returns `{ success: false, error: "ELEVENLABS_API_KEY not configured" }`
- **Cost:** ElevenLabs free tier = 10k chars/month. `eleven_turbo_v2_5` is the cheapest model.
- **Latency:** 2-5 seconds for synthesis + upload
- **Voice IDs:** Get them at <https://elevenlabs.io/docs/voices/voice-lab> or via their API. Rachel (21m00Tcm4TlvDq8ikWAM) is the default because it's in the free tier.
- **Evolution support:** relies on `sendMedia` accepting a `data:` URI. Confirmed working on Evolution 2.3.7.

**Source:** `backend/src/actions/send-voice.action.ts`

---

## Cron expression cheatsheet

Standard 5-field cron (minute hour day-of-month month day-of-week):

| Expression | Meaning |
|---|---|
| `0 9 * * *` | every day at 9:00 |
| `0 9 * * 1` | every Monday at 9:00 |
| `0 9 * * 1-5` | weekdays at 9:00 |
| `*/5 * * * *` | every 5 minutes |
| `0 */2 * * *` | every 2 hours on the hour |
| `0 9 1 * *` | first day of every month at 9:00 |
| `0 9 1 1 *` | new year's day at 9:00 |
| `30 18 * * 5` | fridays at 18:30 |

**Timezone:** cron expressions are evaluated in the server's `TZ` (currently `America/Los_Angeles`), so `0 9 * * 1` means 9am **Pacific time**, not UTC.

Use [crontab.guru](https://crontab.guru) to validate complex expressions before saving.

## Adding a new action type

Say you want to add `sendSlack` that posts to a Slack webhook.

### 1. Create the action file

`backend/src/actions/send-slack.action.ts`:

```typescript
import { z } from "zod";
import type { Action, ActionContext, ActionResult } from "./types.js";

const payloadSchema = z.object({
  webhookUrl: z.string().url(),
  channel: z.string().optional(),
  text: z.string().min(1),
  username: z.string().optional(),
});

export type SendSlackPayload = z.infer<typeof payloadSchema>;

export const sendSlackAction: Action<SendSlackPayload> = {
  type: "sendSlack",
  description: "Post a message to a Slack incoming webhook.",

  validatePayload(payload: unknown): void {
    payloadSchema.parse(payload);
  },

  async execute(ctx: ActionContext, payload: SendSlackPayload): Promise<ActionResult> {
    try {
      const body = {
        text: payload.text,
        ...(payload.channel ? { channel: payload.channel } : {}),
        ...(payload.username ? { username: payload.username } : {}),
      };
      const res = await fetch(payload.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        return {
          success: false,
          output: "",
          error: `Slack returned HTTP ${res.status}`,
        };
      }
      return {
        success: true,
        output: `Posted to Slack (${payload.text.slice(0, 80)})`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: "", error: msg };
    }
  },
};
```

### 2. Register it

`backend/src/actions/registry.ts`:

```typescript
import { sendSlackAction } from "./send-slack.action.js";

export const allActions: Action[] = [
  sendTextAction as Action,
  runCommandAction as Action,
  webhookAction as Action,
  sendVoiceAction as Action,
  sendSlackAction as Action,  // ← add here
];
```

### 3. That's it

- The dashboard form's action dropdown will auto-list `sendSlack`
- The API endpoint `GET /api/schedules/actions` will include it
- You can create a task with `POST /api/schedules` with `actionType: "sendSlack"`

### Testing

Add a unit test that validates the payload and runs the action with a mocked `fetch`. Goes in `backend/src/actions/send-slack.action.test.ts`.

## Action context best practices

- **Logging:** use `ctx.logger` not `console.log` — it's a pino child logger scoped to the task so logs include `taskId` automatically
- **Errors:** always return `ActionResult` instead of throwing if you can. The runner catches thrown errors, but a clean return gives a better `lastError` message
- **Side effects:** prefer idempotent actions — a task may fire twice (e.g. manual run + next scheduled run) and you don't want double-sends
- **Secrets:** read from `process.env` inside `execute()`, not at module load. That way adding a new env var doesn't require a restart to be visible

## Why auto-disable after 10 failures?

Rationale:

- A misconfigured webhook URL with a typo would fire 288 times a day on a `*/5 * * * *` schedule, burning Evolution API calls and filling logs
- 10 strikes is tolerant of transient network blips but catches real problems quickly
- `failureCount` resets to 0 on any successful run, so brief outages don't accumulate
- When auto-disabled, the user gets a WhatsApp notification explaining what happened and how to re-enable

## Why 60-second execution timeout?

Rationale:

- A slow webhook (e.g. a Zapier flow that takes 30s) should still succeed
- A hung fetch (DNS timeout, TCP stuck) would block the runner forever without a timeout
- 60s is tight enough to catch real hangs, loose enough for slow-but-legitimate remote APIs
- The timeout is enforced via `Promise.race([execute, setTimeout(reject, 60_000)])`

## One-shot vs recurring

- **One-shot** (`fireAt` set, `cronExpression` null): fires exactly once at the specified UTC instant. After firing, auto-disables regardless of success/failure. Good for "remind me next Tuesday at 3pm".
- **Recurring** (`cronExpression` set, `fireAt` null): fires on every cron match until explicitly disabled (or auto-disabled after 10 failures). Good for "every Monday morning" reports.

Never set both — the API rejects it.

## Missed fires on boot

If the container was down across a scheduled fire time:

- **Reminders** (`Reminder` model): fired immediately on boot with `⏰ [Missed reminder]` prefix. Status set to `MISSED`.
- **Scheduled tasks** with `cronExpression`: fired immediately if `nextFireAt` was in the past (minus a 2-minute grace window to avoid double-firing something that just ran). `lastResult` is prefixed with `[missed run]`.
- **Scheduled tasks** with `fireAt` in the past: fired immediately (marked as past-due on boot).

The 2-minute grace window on cron tasks exists because `nextFireAt` is set after a fire, and on a normal boot right after a fire, we don't want to re-fire the task.

## Dashboard operations

The `/schedules` page in the dashboard lets you:

- **Create** via form: name, schedule type, cron or fireAt, action type (dropdown), payload JSON (template auto-fills per type)
- **Enable/disable** via checkbox
- **Run now** (▶ button) — fires immediately outside the schedule, good for testing
- **Delete** via trash icon with confirmation

All operations hit `/api/schedules/*` routes documented in the [rebuilding guide](./REBUILDING.md).

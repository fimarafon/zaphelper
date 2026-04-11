# zaphelper — Commands reference

Every slash command supported by zaphelper, how to use it, what it does under the hood, and where the source code lives.

## How commands work

1. User types `/something` in their **WhatsApp self-chat** ("Message yourself")
2. Evolution API forwards the message via webhook
3. `MessageIngest` saves it and sets `isSelfCommand: true` if it starts with `/`
4. `CommandDispatcher` (fire-and-forget) parses the input
5. The matched `Command.execute(ctx)` runs
6. The result is sent back via `evolution.sendText(selfPhone, reply)`
7. The reply appears in the same self-chat, usually within 1-2 seconds

Commands can also be run from the dashboard's Commands page without touching WhatsApp — uses the same code via `CommandDispatcher.runInline()`. Useful for testing.

## Smart parsing

The dispatcher supports two input styles:

- **With space**: `/status 04/09`
- **Without space**: `/status04/09`

The second form works by finding the **longest command prefix** that matches. So `/status04/03to04/09` resolves to command `status` + arg `04/03to04/09`, and `/statusyesterday` resolves to command `statusyesterday` (not `status` + arg `yesterday`).

## Commands

### `/help`

**Aliases:** `/?`, `/h`

Lists every registered command with its description and usage.

**Source:** `backend/src/commands/help.command.ts`

---

### `/statustoday`

**Aliases:** `/today`

Leads posted today in the Be Home Leads Scheduled group, grouped by poster and by source.

**Example output:**

```
📊 Scheduled Leads — Today (04/11):
Total: 9 leads

By person:
• Laura — 5
• Yaniliz Jimenez — 3
• AlexH. — 1

By source:
• Angi — 4
• Thumbtack — 3
• Facebook — 2

⏭️  Ignored 2 non-lead msg(s): 2 short (chat/coordination)
Use /audit to review ignored messages.
```

**Behavior:** window starts at `startOfTodayInTz(now, TZ)` (00:00 in your timezone, default America/Los_Angeles) and ends at `now`. Queries the `Message` table by `chatName contains "Be Home Leads Scheduled"` + `timestamp` range.

**Source:** `backend/src/commands/status-today.command.ts` + `status-shared.ts`

---

### `/statusyesterday`

**Aliases:** `/yesterday`

Same as `/statustoday` but for yesterday only (00:00 to 23:59:59.999 of the previous calendar day).

---

### `/status7days`

**Aliases:** `/7days`, `/last7days`

Rolling 7-day window: from the start of 6 days ago to now. Different from `/statusweek`, which is Monday-based.

---

### `/statusweek`

**Aliases:** `/week`

Monday-through-now for the current week. On Tuesday, you get Mon+Tue. On Sunday, you get the whole week.

---

### `/statusmonth`

**Aliases:** `/month`, `/mtd`

Month-to-date: from day 1 of the current month to now. The label shows the month name (e.g. "April").

---

### `/status <date|range>`

Flexible: accepts any date or range in multiple formats.

**Single-day formats:**

| Input | Meaning |
|---|---|
| `/status04/09` | April 9 of the current year (MM/DD) |
| `/status 04/09` | Same with space |
| `/status4/9` | Same, no leading zeros |
| `/status04/09/2026` | Explicit year |
| `/status2026-04-09` | ISO format |
| `/status 2026-04-09` | ISO with space |

**Range formats:**

| Input | Meaning |
|---|---|
| `/status04/03to04/09` | Apr 3 through Apr 9 (inclusive) |
| `/status04/03 to 04/09` | Same with spaces |
| `/status04/03-04/09` | Dash separator |
| `/status04/03..04/09` | Dot separator |

All ranges are **inclusive** on both ends: start-of-day on the left, end-of-day on the right.

**Errors:** Invalid dates (e.g. `02/30`) return a helpful error message. Year is always interpreted as current year unless you specify a 4-digit year.

**Source:** `backend/src/commands/status.command.ts` + `utils/dates.ts#parseStatusRange`

---

### `/audit [date|range]`

Shows the messages in the lead group that were **NOT** counted as leads, with the reason why. Transparency tool — use it when `/statustoday` returns a number that seems wrong.

**Example output:**

```
🔍 Audit — This week
Total msgs: 107 | Leads: 78 | Ignored: 29

1. 04/07 10:45 J.K [short]
   "No more for Washington and Oregon tomorrow"
2. 04/07 10:47 J.K [short]
   "came from facebook"
...

Legend: short=1 line (chatter), no-signal=no name/phone/date, empty=empty or media.
```

**Reasons for skipping:**

- **`short`** (`too_short`): message has only 1 non-empty line → not a lead, it's chatter
- **`no-signal`**: message has multiple lines but no name/phone/scheduled date — it's a discussion, not a lead
- **`empty`**: empty content or media without caption

**Source:** `backend/src/commands/audit.command.ts`

---

### `/reminder YYYY-MM-DD HH:MM <message>`

**Aliases:** `/remind`

Schedules a one-shot reminder. The bot sends the message back to your self-chat at the specified time.

**Example:**

```
/reminder 2026-04-14 09:00 Call Jack about the new estimate
```

**Reply:**

```
✅ Reminder set for 2026-04-14 09:00 (America/Los_Angeles)
> Call Jack about the new estimate
```

**Timing:** stored in UTC, displayed/parsed in the server's `TZ`. Uses `setTimeout` under the hood, with a daily sweep for reminders >24.8 days in the future. Past-due reminders on startup fire immediately with a `⏰ [Missed reminder]` prefix.

**Source:** `backend/src/commands/reminder.command.ts` + `services/scheduler.ts`

---

### `/reminders`

**Aliases:** `/listreminders`

Lists all active (PENDING) reminders ordered by scheduled time.

**Example output:**

```
📋 3 active reminder(s):

1. 2026-04-12 09:00 — Call Jack about the new estimate
2. 2026-04-15 14:30 — Prepare slides for presentation
3. 2026-05-01 09:00 — Monthly review
```

---

### `/schedule <mode> ...`

Creates a recurring or one-shot scheduled task. Delegates to the `ScheduledTaskService`.

**Three modes:**

**Daily:**
```
/schedule daily HH:MM <command-or-text>
```
Example: `/schedule daily 18:00 /statustoday`
→ Runs `/statustoday` every day at 6pm local time.

**Weekly:**
```
/schedule weekly <dow> HH:MM <command-or-text>
```
where `<dow>` is one of `sun|mon|tue|wed|thu|fri|sat`.

Example: `/schedule weekly mon 09:00 /statusweek`
→ Runs `/statusweek` every Monday at 9am.

**One-shot:**
```
/schedule once YYYY-MM-DD HH:MM <command-or-text>
```

Example: `/schedule once 2026-04-15 14:00 Team meeting in 15 min`
→ Sends the text message at that exact time, then auto-disables.

**Action inference:** if the body starts with `/`, it's a `runCommand` action (executes the command internally and delivers the reply to self-chat). Otherwise, it's a `sendText` action to self.

**For more complex configs** (custom cron, webhook actions, voice), use the dashboard's `/schedules` page.

**Source:** `backend/src/commands/schedule.command.ts` (factory function — needs `ScheduledTaskService` injected at registry build time)

---

### `/schedules`

**Aliases:** `/listschedules`

Lists all scheduled tasks with their status, cron expression, action type, and last run info.

**Example output:**

```
📋 3 scheduled task(s):

1. ✅ Weekly mon 09:00 /statusweek
   cron: `0 9 * * 1`
   action: runCommand | id: cmnuij71
   last run: 04/11 08:52

2. ✅ Daily 18:00 /statustoday
   cron: `0 18 * * *`
   action: runCommand | id: cmnuij6k

3. ⏸️ Backup cron
   cron: `0 3 * * *`
   action: webhook | id: cmn2qxp0
   ⚠️ last error: HTTP 500: database busy
```

`✅` = enabled, `⏸️` = disabled. Auto-disabled tasks (after 10 consecutive failures) show as `⏸️` with the last error.

---

### `/unschedule <N | id-prefix>`

**Aliases:** `/deleteschedule`

Deletes a scheduled task. Accepts either:

- A number (1-based index from `/schedules`), e.g. `/unschedule 2`
- An ID prefix (first ~8 chars of the task's cuid), e.g. `/unschedule cmnuij71`

**Reply:**

```
🗑️  Deleted task: Weekly mon 09:00 /statusweek
```

---

## Adding a new command

See [`ACTIONS.md`](./ACTIONS.md) for scheduled task actions. For a new *command* (slash command the user types):

1. Create `backend/src/commands/<name>.command.ts`:

```typescript
import type { Command } from "./types.js";

export const myCommand: Command = {
  name: "mycommand",           // what the user types after "/"
  aliases: ["mc"],             // optional additional names
  description: "Short one-liner shown in /help.",
  usage: "/mycommand <args>",  // optional usage hint
  async execute(ctx) {
    // ctx contains: args, rawInput, prisma, evolution, scheduler,
    // selfJid, selfPhone, config, logger, now, getCommands
    return {
      success: true,
      reply: `Hello from ${ctx.selfPhone}!`,
    };
  },
};
```

2. Import + register in `backend/src/commands/registry.ts`:

```typescript
import { myCommand } from "./my.command.js";

export const staticCommands: Command[] = [
  // ...existing commands...
  myCommand,
];
```

3. `git push` → EasyPanel auto-rebuilds → command is live

### If the command needs runtime services

If your command needs a service that's constructed at startup (like `ScheduledTaskService`), use a factory function instead:

```typescript
export function createMyCommand(taskService: ScheduledTaskService): Command {
  return {
    name: "mycommand",
    // ...
    async execute(ctx) {
      await taskService.doSomething();
      return { success: true, reply: "Done" };
    },
  };
}
```

And register it in `buildCommandList()` inside `registry.ts`:

```typescript
export function buildCommandList(deps: { taskService?: ScheduledTaskService }): Command[] {
  const list: Command[] = [...staticCommands];
  if (deps.taskService) {
    list.push(createMyCommand(deps.taskService));
  }
  return list;
}
```

## Command context reference

Every command receives a `CommandContext`:

```typescript
interface CommandContext {
  args: string[];                  // whitespace-split tokens after the command
  rawInput: string;                // everything after the command name, preserving whitespace
  command: string;                 // the canonical command name
  prisma: PrismaClient;            // for DB queries
  evolution: EvolutionClient;      // for direct WhatsApp calls
  scheduler: Scheduler;            // reminder scheduler (not the generic task runner)
  selfJid: string;                 // e.g. "16198886149@s.whatsapp.net"
  selfPhone: string;               // e.g. "16198886149"
  config: AppConfig;               // full env config
  logger: Logger;                  // pino child logger scoped to the command
  now: Date;                       // injected for testability
  getCommands: () => Command[];    // lazy accessor — avoids circular imports
}
```

## Testing commands

Two ways to test without touching WhatsApp:

### Dashboard test runner

1. Open `https://zaphelper.maverstudio.com` → Commands page
2. Use the "🧪 Test command" input at the top
3. Type the command, hit Run
4. Result appears below; command is logged in `CommandLog` table with `messageId: null`

### API

```bash
curl -X POST -b cookies.txt -H "Content-Type: application/json" \
  -d '{"input":"/statustoday"}' \
  https://zaphelper.maverstudio.com/api/commands/run
```

Returns `{ success, reply, error? }`. Authenticated.

## Localization

Currently all replies are in English. The command source code uses English strings. To add localization:

1. Introduce a `locale` concept in `AppConfig` and `CommandContext`
2. Replace string literals with lookup keys
3. Add `locales/{en,pt}.json` files
4. Use a helper `t(ctx, "key", vars)` in commands

Not done today — single-user project, English is fine.

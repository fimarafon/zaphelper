import type { Command } from "./types.js";
import type { ScheduledTaskService } from "../services/scheduled-task-service.js";

/**
 * Lightweight /schedule command that supports the 3 most common cases
 * via WhatsApp shorthand. For complex configs, direct users to the web UI.
 *
 * Syntax:
 *   /schedule daily HH:MM <command-or-text>
 *   /schedule weekly <dow> HH:MM <command-or-text>
 *   /schedule once YYYY-MM-DD HH:MM <command-or-text>
 *
 * Where:
 *   - <dow> is mon|tue|wed|thu|fri|sat|sun
 *   - If the body starts with /, it's treated as a runCommand action
 *   - Otherwise it's treated as a sendText action to self
 *
 * Examples:
 *   /schedule daily 18:00 /statustoday
 *     → runs /statustoday every day at 6pm, delivers to self
 *   /schedule weekly mon 09:00 /statusweek
 *     → weekly report every Monday 9am
 *   /schedule daily 09:00 Good morning! Have a great day
 *     → sends text message every morning at 9
 */
export function createScheduleCommand(taskService: ScheduledTaskService): Command {
  return {
    name: "schedule",
    description: "Create a scheduled task (daily / weekly / once).",
    usage:
      "/schedule daily HH:MM <cmd|text>\n" +
      "  /schedule weekly <dow> HH:MM <cmd|text>\n" +
      "  /schedule once YYYY-MM-DD HH:MM <cmd|text>",
    async execute(ctx) {
      const { args } = ctx;
      if (args.length === 0) {
        return {
          success: false,
          reply:
            "❌ Usage:\n" +
            "  `/schedule daily 18:00 /statustoday`\n" +
            "  `/schedule weekly mon 09:00 /statusweek`\n" +
            "  `/schedule once 2026-04-15 14:00 Team meeting reminder`\n\n" +
            "For advanced options (custom cron, webhook actions, voice), use the web dashboard.",
          error: "missing_args",
        };
      }

      const mode = (args[0] ?? "").toLowerCase();

      try {
        if (mode === "daily") {
          return await handleDaily(args.slice(1), taskService);
        }
        if (mode === "weekly") {
          return await handleWeekly(args.slice(1), taskService);
        }
        if (mode === "once") {
          return await handleOnce(args.slice(1), taskService);
        }
        return {
          success: false,
          reply: `❌ Unknown mode "${mode}". Use: daily, weekly, or once.`,
          error: "unknown_mode",
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          reply: `❌ ${msg}`,
          error: msg,
        };
      }
    },
  };
}

// --- helpers ---

const DOW_MAP: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

async function handleDaily(
  args: string[],
  taskService: ScheduledTaskService,
): Promise<{ success: boolean; reply: string; error?: string }> {
  const time = args[0];
  const body = args.slice(1).join(" ").trim();
  if (!time || !body) {
    return { success: false, reply: "❌ Usage: `/schedule daily HH:MM <cmd|text>`" };
  }
  const parsed = parseHHMM(time);
  if (!parsed) return { success: false, reply: `❌ Invalid time "${time}"` };

  const cronExpression = `${parsed.minute} ${parsed.hour} * * *`;
  const task = await taskService.create({
    name: `Daily ${time}${body.startsWith("/") ? ` ${body}` : ""}`,
    actionType: inferActionType(body),
    actionPayload: buildPayload(body),
    cronExpression,
  });
  return {
    success: true,
    reply:
      `✅ Daily task created\n` +
      `*${task.name}*\n` +
      `Cron: \`${cronExpression}\`\n` +
      `Action: ${task.actionType}\n\n` +
      `Manage it in the web dashboard or via /schedules.`,
  };
}

async function handleWeekly(
  args: string[],
  taskService: ScheduledTaskService,
): Promise<{ success: boolean; reply: string; error?: string }> {
  const dow = (args[0] ?? "").toLowerCase();
  const time = args[1];
  const body = args.slice(2).join(" ").trim();
  if (!(dow in DOW_MAP) || !time || !body) {
    return {
      success: false,
      reply: "❌ Usage: `/schedule weekly mon 09:00 <cmd|text>` (dow: sun/mon/tue/wed/thu/fri/sat)",
    };
  }
  const parsed = parseHHMM(time);
  if (!parsed) return { success: false, reply: `❌ Invalid time "${time}"` };

  const cronExpression = `${parsed.minute} ${parsed.hour} * * ${DOW_MAP[dow]}`;
  const task = await taskService.create({
    name: `Weekly ${dow} ${time}${body.startsWith("/") ? ` ${body}` : ""}`,
    actionType: inferActionType(body),
    actionPayload: buildPayload(body),
    cronExpression,
  });
  return {
    success: true,
    reply:
      `✅ Weekly task created\n` +
      `*${task.name}*\n` +
      `Cron: \`${cronExpression}\` (${dow} at ${time})\n` +
      `Action: ${task.actionType}`,
  };
}

async function handleOnce(
  args: string[],
  taskService: ScheduledTaskService,
): Promise<{ success: boolean; reply: string; error?: string }> {
  const dateStr = args[0];
  const timeStr = args[1];
  const body = args.slice(2).join(" ").trim();
  if (!dateStr || !timeStr || !body) {
    return {
      success: false,
      reply: "❌ Usage: `/schedule once YYYY-MM-DD HH:MM <cmd|text>`",
    };
  }
  // Parse as local time in the system TZ via ISO construction.
  const parsed = parseHHMM(timeStr);
  if (!parsed) return { success: false, reply: `❌ Invalid time "${timeStr}"` };

  // Build a Date from the components assuming system local time.
  // ISO format lets JS parse it with timezone offset; we let Node apply the
  // configured TZ env var (TZ=America/Los_Angeles) since the server has it.
  const fireAt = new Date(`${dateStr}T${timeStr.length === 5 ? timeStr : `${parsed.hour}:${parsed.minute}`}:00`);
  if (Number.isNaN(fireAt.getTime())) {
    return { success: false, reply: `❌ Invalid date "${dateStr}"` };
  }
  if (fireAt.getTime() <= Date.now()) {
    return { success: false, reply: "❌ Time must be in the future." };
  }

  const task = await taskService.create({
    name: `Once ${dateStr} ${timeStr}${body.startsWith("/") ? ` ${body}` : ""}`,
    actionType: inferActionType(body),
    actionPayload: buildPayload(body),
    fireAt,
  });
  return {
    success: true,
    reply:
      `✅ One-shot task created\n` +
      `*${task.name}*\n` +
      `Fires at: ${dateStr} ${timeStr}\n` +
      `Action: ${task.actionType}`,
  };
}

function parseHHMM(s: string): { hour: number; minute: number } | null {
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = parseInt(m[1]!, 10);
  const minute = parseInt(m[2]!, 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function inferActionType(body: string): string {
  return body.startsWith("/") ? "runCommand" : "sendText";
}

function buildPayload(body: string): Record<string, unknown> {
  if (body.startsWith("/")) {
    return { command: body, deliverToSelf: true };
  }
  return { to: "self", text: body };
}

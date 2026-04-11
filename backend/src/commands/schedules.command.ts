import { formatInTz } from "../utils/dates.js";
import type { Command } from "./types.js";
import type { ScheduledTaskService } from "../services/scheduled-task-service.js";

/**
 * /schedules — list active scheduled tasks.
 * /unschedule <N> or <id-prefix> — disable/delete a task.
 */
export function createSchedulesCommand(taskService: ScheduledTaskService): Command {
  return {
    name: "schedules",
    aliases: ["listschedules"],
    description: "List all scheduled tasks.",
    usage: "/schedules",
    async execute(ctx) {
      const tasks = await taskService.list();
      if (tasks.length === 0) {
        return { success: true, reply: "📭 No scheduled tasks." };
      }

      const lines = [`📋 *${tasks.length} scheduled task(s):*`, ""];
      tasks.forEach((t, i) => {
        const enabled = t.enabled ? "✅" : "⏸️";
        const schedule = t.cronExpression
          ? `cron: \`${t.cronExpression}\``
          : t.fireAt
            ? `once: ${formatInTz(t.fireAt, ctx.config.TZ, "yyyy-MM-dd HH:mm")}`
            : "(no schedule)";
        lines.push(`${i + 1}. ${enabled} *${t.name}*`);
        lines.push(`   ${schedule}`);
        lines.push(`   action: \`${t.actionType}\` | id: \`${t.id.slice(0, 8)}\``);
        if (t.lastError) {
          lines.push(`   ⚠️ last error: ${t.lastError.slice(0, 100)}`);
        } else if (t.lastFiredAt) {
          lines.push(`   last run: ${formatInTz(t.lastFiredAt, ctx.config.TZ, "MM/dd HH:mm")}`);
        }
        lines.push("");
      });

      lines.push("_Use /unschedule <number> to delete one._");
      return { success: true, reply: lines.join("\n") };
    },
  };
}

export function createUnscheduleCommand(taskService: ScheduledTaskService): Command {
  return {
    name: "unschedule",
    aliases: ["deleteschedule"],
    description: "Delete a scheduled task by its number (from /schedules).",
    usage: "/unschedule <N or id-prefix>",
    async execute(ctx) {
      const { args } = ctx;
      if (args.length === 0) {
        return {
          success: false,
          reply: "❌ Usage: `/unschedule <N>` — where N is the number from /schedules",
          error: "missing_arg",
        };
      }

      const target = args[0]!;
      const tasks = await taskService.list();

      // Try as a number first.
      const asNumber = parseInt(target, 10);
      let task = null;
      if (!Number.isNaN(asNumber) && asNumber >= 1 && asNumber <= tasks.length) {
        task = tasks[asNumber - 1];
      } else {
        // Try as an ID prefix.
        task = tasks.find((t) => t.id.startsWith(target));
      }

      if (!task) {
        return {
          success: false,
          reply: `❌ No task matches "${target}". Use /schedules to list.`,
          error: "not_found",
        };
      }

      await taskService.delete(task.id);
      return {
        success: true,
        reply: `🗑️  Deleted task: *${task.name}*`,
      };
    },
  };
}

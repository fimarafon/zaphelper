import { formatInTz, parseDateInTz } from "../utils/dates.js";
import type { Command } from "./types.js";

export const reminderCommand: Command = {
  name: "reminder",
  aliases: ["remind"],
  description: "Schedule a reminder — I'll DM you at the given date/time.",
  usage: "/reminder YYYY-MM-DD HH:MM <message>",
  async execute(ctx) {
    const { args, prisma, scheduler, config } = ctx;
    if (args.length < 3) {
      return {
        success: false,
        reply:
          "❌ Invalid format.\n" +
          "Use: `/reminder YYYY-MM-DD HH:MM <message>`\n" +
          "Example: `/reminder 2026-04-14 09:00 Call the supplier`",
        error: "too_few_args",
      };
    }

    const dateStr = args[0]!;
    const timeStr = args[1]!;
    const message = args.slice(2).join(" ");

    const scheduledAt = parseDateInTz(`${dateStr} ${timeStr}`, config.TZ);
    if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) {
      return {
        success: false,
        reply: `❌ Could not parse "${dateStr} ${timeStr}". Use format YYYY-MM-DD HH:MM.`,
        error: "parse",
      };
    }

    if (scheduledAt.getTime() <= Date.now()) {
      return {
        success: false,
        reply: "❌ Reminder time must be in the future.",
        error: "past",
      };
    }

    const reminder = await prisma.reminder.create({
      data: {
        scheduledAt,
        message,
        status: "PENDING",
      },
    });

    scheduler.schedule(reminder);

    const localized = formatInTz(scheduledAt, config.TZ, "yyyy-MM-dd HH:mm");
    return {
      success: true,
      reply: `✅ Reminder set for *${localized}* (${config.TZ})\n> ${message}`,
    };
  },
};

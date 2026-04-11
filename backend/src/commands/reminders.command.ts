import { formatInTz } from "../utils/dates.js";
import type { Command } from "./types.js";

export const remindersCommand: Command = {
  name: "reminders",
  aliases: ["listreminders"],
  description: "List all active reminders.",
  usage: "/reminders",
  async execute(ctx) {
    const { prisma, config } = ctx;
    const active = await prisma.reminder.findMany({
      where: { status: "PENDING" },
      orderBy: { scheduledAt: "asc" },
    });

    if (active.length === 0) {
      return { success: true, reply: "📭 No active reminders." };
    }

    const lines = [`📋 *${active.length} active reminder(s):*`, ""];
    active.forEach((r, i) => {
      const when = formatInTz(r.scheduledAt, config.TZ, "yyyy-MM-dd HH:mm");
      lines.push(`${i + 1}. ${when} — ${r.message}`);
    });
    return { success: true, reply: lines.join("\n") };
  },
};

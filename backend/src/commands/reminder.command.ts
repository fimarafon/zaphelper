import { formatInTz, parseDateInTz } from "../utils/dates.js";
import type { Command } from "./types.js";

export const reminderCommand: Command = {
  name: "reminder",
  aliases: ["remind", "lembrete"],
  description: "Agenda um lembrete — o bot te envia a mensagem no dia/hora.",
  usage: "/reminder YYYY-MM-DD HH:MM <mensagem>",
  async execute(ctx) {
    const { args, prisma, scheduler, config } = ctx;
    if (args.length < 3) {
      return {
        success: false,
        reply:
          "❌ Formato inválido.\n" +
          "Use: `/reminder YYYY-MM-DD HH:MM <mensagem>`\n" +
          "Exemplo: `/reminder 2026-04-14 09:00 Ligar pro fornecedor`",
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
        reply: `❌ Não consegui interpretar "${dateStr} ${timeStr}". Use o formato YYYY-MM-DD HH:MM.`,
        error: "parse",
      };
    }

    if (scheduledAt.getTime() <= Date.now()) {
      return {
        success: false,
        reply: "❌ O horário do lembrete precisa estar no futuro.",
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
      reply: `✅ Lembrete marcado para *${localized}* (${config.TZ})\n> ${message}`,
    };
  },
};

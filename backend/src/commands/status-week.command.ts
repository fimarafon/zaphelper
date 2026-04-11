import { buildStatusReply } from "./status-shared.js";
import type { Command } from "./types.js";
import { startOfWeekMondayInTz } from "../utils/dates.js";

export const statusWeekCommand: Command = {
  name: "statusweek",
  aliases: ["week"],
  description: "Resume os leads agendados da semana (seg → agora).",
  usage: "/statusweek",
  async execute(ctx) {
    const start = startOfWeekMondayInTz(ctx.now, ctx.config.TZ);
    return buildStatusReply(ctx, { label: "Semana", start, end: ctx.now });
  },
};

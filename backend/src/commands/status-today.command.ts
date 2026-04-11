import { buildStatusReply } from "./status-shared.js";
import type { Command } from "./types.js";
import { startOfTodayInTz } from "../utils/dates.js";

export const statusTodayCommand: Command = {
  name: "statustoday",
  aliases: ["today"],
  description: "Resume os leads agendados hoje no grupo Be Home.",
  usage: "/statustoday",
  async execute(ctx) {
    const start = startOfTodayInTz(ctx.now, ctx.config.TZ);
    return buildStatusReply(ctx, { label: "Hoje", start, end: ctx.now });
  },
};

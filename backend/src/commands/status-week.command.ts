import { buildStatusReply } from "./status-shared.js";
import type { Command } from "./types.js";
import { startOfWeekMondayInTz } from "../utils/dates.js";

export const statusWeekCommand: Command = {
  name: "statusweek",
  aliases: ["week"],
  description: "Summary of scheduled leads this week (Mon → now).",
  usage: "/statusweek",
  async execute(ctx) {
    const start = startOfWeekMondayInTz(ctx.now, ctx.config.TZ);
    return buildStatusReply(ctx, { label: "This week", start, end: ctx.now });
  },
};

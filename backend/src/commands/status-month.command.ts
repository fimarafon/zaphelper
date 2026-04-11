import { formatInTz, startOfMonthInTz } from "../utils/dates.js";
import { buildStatusReply } from "./status-shared.js";
import type { Command } from "./types.js";

export const statusMonthCommand: Command = {
  name: "statusmonth",
  aliases: ["month", "mtd"],
  description: "Summary of scheduled leads this month (day 1 → now).",
  usage: "/statusmonth",
  async execute(ctx) {
    const tz = ctx.config.TZ;
    const start = startOfMonthInTz(ctx.now, tz);
    const monthLabel = formatInTz(ctx.now, tz, "MMMM");
    return buildStatusReply(ctx, {
      label: monthLabel,
      start,
      end: ctx.now,
      shortDate: formatInTz(ctx.now, tz, "MM/dd"),
    });
  },
};

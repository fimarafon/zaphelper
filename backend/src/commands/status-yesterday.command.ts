import { endOfYesterdayInTz, formatInTz, startOfYesterdayInTz } from "../utils/dates.js";
import { buildStatusReply } from "./status-shared.js";
import type { Command } from "./types.js";

export const statusYesterdayCommand: Command = {
  name: "statusyesterday",
  aliases: ["yesterday"],
  description: "Summary of scheduled leads posted yesterday.",
  usage: "/statusyesterday",
  async execute(ctx) {
    const tz = ctx.config.TZ;
    const start = startOfYesterdayInTz(ctx.now, tz);
    const end = endOfYesterdayInTz(ctx.now, tz);
    return buildStatusReply(ctx, {
      label: "Yesterday",
      start,
      end,
      shortDate: formatInTz(start, tz, "MM/dd"),
    });
  },
};
